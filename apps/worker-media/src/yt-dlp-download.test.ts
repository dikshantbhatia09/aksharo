import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaJobError } from "./errors.js";
import { logger } from "./logger.js";
import {
  DownloaderUnusableError,
  EXPECTED_VERSION,
  assertYtDlpUsable,
  download,
  probeSource,
} from "./yt-dlp.js";

import type { AcquireLimits } from "./yt-dlp.js";
import type { ChildProcess } from "node:child_process";

/**
 * The downloader as a process: what it prints, on which stream, and what it
 * leaves on disk. The binary itself is faked — the network, YouTube and a
 * rights-cleared video are the staging spike's job — but every fake here
 * replays what yt-dlp 2026.08.19 actually does, and the scratch directory is a
 * real one, because the size watch reads it.
 */

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: vi.fn(),
}));

// The real readdir, counted: a test of what the size watch leaves alone has to
// know the watch actually measured, or it passes by never looking.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readdir: vi.fn(actual["readdir"] as (...args: unknown[]) => unknown) };
});

const spawnMock = vi.mocked(spawn);
const readdirMock = vi.mocked(readdir);

/** Resolve once the size watch has begun `count` more measurements of the scratch directory. */
async function measurements(count: number): Promise<void> {
  const target = readdirMock.mock.calls.length + count;
  while (readdirMock.mock.calls.length < target) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A child process with real streams, driven by the test. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];

  kill(signal: string): boolean {
    this.signals.push(signal);
    // yt-dlp dies on SIGTERM; `close` then carries no exit code.
    if (signal === "SIGTERM") void this.exit(null, signal);
    return true;
  }

  /** End both streams, let their data drain, then close — the order Node uses. */
  async exit(code: number | null, signal: string | null = null): Promise<void> {
    const drained = Promise.all([once(this.stdout, "end"), once(this.stderr, "end")]);
    this.stdout.end();
    this.stderr.end();
    await drained;
    this.emit("close", code, signal);
  }
}

type Script = (child: FakeChild, args: readonly string[]) => Promise<void> | void;

/** Every spawn runs `script`; returns the argument lists it was given. */
function fakeDownloader(script: Script): { readonly calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  spawnMock.mockImplementation(((_binary: string, args: readonly string[]) => {
    calls.push(args);
    const child = new FakeChild();
    setImmediate(() => {
      void script(child, args);
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn);
  return { calls };
}

const LIMITS: AcquireLimits = { maxBytes: 1_000, maxDurationMs: 1_200_000, timeoutMs: 60_000 };
const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

let dir: string;
let output: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "montaj-acquire-test-"));
  output = join(dir, "source.mp4");
});

afterEach(async () => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** Write `bytes` bytes to `name` in the job's scratch directory, as yt-dlp would. */
async function put(name: string, bytes: number): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own temp directory
  await writeFile(join(dir, name), "x".repeat(bytes));
}

async function failure(promise: Promise<unknown>): Promise<MediaJobError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MediaJobError);
  return error as MediaJobError;
}

describe("download", () => {
  it("reads progress from stdout, where --newline puts it", async () => {
    fakeDownloader(async (child) => {
      child.stdout.write("[download] Destination: source.f137.mp4\n");
      child.stdout.write("[download]  12.5% of  170.22MiB at  4.20MiB/s ETA 00:35\n");
      // A chunk that splits a line, and a carriage-return ending.
      child.stdout.write("[download]  50.0% of  170.22MiB");
      child.stdout.write(" at  4.20MiB/s ETA 00:20\r[download] 100% of  170.22MiB\n");
      await put("source.mp4", 10);
      await child.exit(0);
    });
    const seen: number[] = [];
    await download({
      binary: "yt-dlp",
      url: URL,
      outputPath: output,
      limits: LIMITS,
      onProgress: (percent) => seen.push(percent),
    });
    expect(seen).toEqual([12.5, 50, 100]);
  });

  it("turns the max-filesize abort (stdout, exit 0, no file) into too_large, not ENOENT", async () => {
    // yt-dlp skips the oversize part, never merges, and exits 0. Unhandled,
    // the missing file surfaced as a retryable ENOENT and the whole video was
    // fetched three times before the user heard anything.
    fakeDownloader(async (child) => {
      child.stdout.write("[info] x: Downloading 1 format(s): 401+140\n");
      child.stdout.write(
        "\r[download] File is larger than max-filesize (538391240 bytes > 524288000 bytes). Aborting.\n",
      );
      await put("source.f140.m4a", 1);
      await child.exit(0);
    });
    const error = await failure(
      download({ binary: "yt-dlp", url: URL, outputPath: output, limits: LIMITS }),
    );
    expect(error).toMatchObject({ reason: "media/too_large", retryable: false });
    expect(error.message).not.toMatch(/ENOENT/);
  });

  it("names an exit 0 with no file and no explanation, and lets it retry", async () => {
    fakeDownloader(async (child) => {
      child.stdout.write("[info] x: Downloading 1 format(s): 137+140\n");
      await child.exit(0);
    });
    const error = await failure(
      download({ binary: "yt-dlp", url: URL, outputPath: output, limits: LIMITS }),
    );
    expect(error).toMatchObject({
      code: "media/acquire_no_output",
      retryable: true,
      reason: "media/source_failed",
    });
  });

  it("classifies a failed exit from stderr and stdout together", async () => {
    fakeDownloader(async (child) => {
      child.stdout.write("[youtube] Extracting URL: https://www.youtube.com/watch?v=x\n");
      child.stderr.write("ERROR: [youtube] x: Sign in to confirm you're not a bot.\n");
      await child.exit(1);
    });
    const error = await failure(
      download({ binary: "yt-dlp", url: URL, outputPath: output, limits: LIMITS }),
    );
    expect(error).toMatchObject({ reason: "media/source_blocked", retryable: false });
  });

  it("kills a download whose bytes on disk pass the cap, which --max-filesize never does for fragments", async () => {
    let child: FakeChild | undefined;
    fakeDownloader(async (started) => {
      child = started;
      // An HLS stream: fragments appended to a .part file, no size checked by
      // yt-dlp, and no exit until something stops it. With no length to go on,
      // its progress lines are byte counts rather than percentages.
      started.stdout.write("[download] Destination: source.f625.mp4\n");
      started.stdout.write("[download]    1.99MiB at    1.03MiB/s (00:00:01)\n");
      await put("source.f625.mp4.part", 800);
      await put("source.f625.mp4.part-Frag7", 400);
    });
    const error = await failure(
      download({
        binary: "yt-dlp",
        url: URL,
        outputPath: output,
        limits: LIMITS,
        sizeCheckIntervalMs: 10,
      }),
    );
    expect(error).toMatchObject({
      reason: "media/too_large",
      code: "media/too_large",
      retryable: false,
    });
    expect(child?.signals).toContain("SIGTERM");
    // The operator's detail keeps what the downloader said, not its odometer.
    expect(error.detail).toContain("Destination: source.f625.mp4");
    expect(error.detail).not.toContain("MiB at");
  });

  it("does not count a merge's second copy or the finished file against the cap", async () => {
    // Mid-merge, the parts, `source.temp.mp4` and then `source.mp4` sit side by
    // side: counting them all (2 700 bytes) would kill every download over
    // half the cap. The parts alone are 900, under the 1 000 cap.
    let child: FakeChild | undefined;
    let survivedMeasurement = false;
    fakeDownloader(async (started) => {
      child = started;
      await put("source.f137.mp4", 600);
      await put("source.f140.m4a", 300);
      await put("source.temp.mp4", 900);
      await put("source.mp4", 900);
      // Two measurements begun after the writes: the watch runs one at a time,
      // so the first of them has finished, and decided, by the second.
      await measurements(2);
      survivedMeasurement = started.signals.length === 0;
      // The control: one more counted part takes it over, and it is killed —
      // so the watch was live, and the exclusions are what spared it above.
      await put("source.f251.webm", 200);
    });
    const error = await failure(
      download({
        binary: "yt-dlp",
        url: URL,
        outputPath: output,
        limits: LIMITS,
        sizeCheckIntervalMs: 10,
      }),
    );
    expect(survivedMeasurement).toBe(true);
    expect(error.reason).toBe("media/too_large");
    expect(child?.signals).toContain("SIGTERM");
  });

  it("hands yt-dlp the configured ffmpeg for the merge", async () => {
    const { calls } = fakeDownloader(async (child) => {
      await put("source.mp4", 1);
      await child.exit(0);
    });
    await download({
      binary: "yt-dlp",
      url: URL,
      outputPath: output,
      limits: LIMITS,
      format: "137+140",
      ffmpegPath: "C:/tools/ffmpeg/bin/ffmpeg.exe",
    });
    const args = calls[0] ?? [];
    expect(args[args.indexOf("--ffmpeg-location") + 1]).toBe("C:/tools/ffmpeg/bin/ffmpeg.exe");
    expect(args[args.indexOf("-f") + 1]).toBe("137+140");
  });

  it("sends yt-dlp's warnings to the operator log, redacted, and succeeds anyway", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    fakeDownloader(async (child) => {
      child.stderr.write(
        "WARNING: [youtube] x: Some formats may be missing. See https://cdn.test/a?sig=secret\n",
      );
      await put("source.mp4", 1);
      await child.exit(0);
    });
    await download({ binary: "yt-dlp", url: URL, outputPath: output, limits: LIMITS });
    const logged = warn.mock.calls.map(([, fields]) => String(fields?.["warning"]));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("Some formats may be missing");
    expect(logged[0]).not.toContain("secret");
  });
});

describe("probeSource", () => {
  function probeReturning(dump: Record<string, unknown>): void {
    fakeDownloader(async (child) => {
      child.stdout.write(JSON.stringify(dump));
      await child.exit(0);
    });
  }

  const VIDEO = {
    id: "x",
    title: "Episode 12",
    extractor_key: "Youtube",
    duration: 600,
    formats: [],
  };

  it("refuses a playlist as a playlist", async () => {
    probeReturning({ ...VIDEO, entries: [{ id: "a" }] });
    const error = await failure(probeSource({ binary: "yt-dlp", url: URL, limits: LIMITS }));
    expect(error).toMatchObject({ reason: "media/source_playlist", retryable: false });
  });

  it("refuses a premiere that has not started, and a stream still being processed", async () => {
    for (const dump of [
      { ...VIDEO, live_status: "is_upcoming", duration: null },
      { ...VIDEO, live_status: "post_live", duration: null },
      { ...VIDEO, live_status: "is_live" },
    ]) {
      probeReturning(dump);
      const error = await failure(probeSource({ binary: "yt-dlp", url: URL, limits: LIMITS }));
      expect(error.reason, String(dump.live_status)).toBe("media/source_live");
    }
  });

  it("accepts a finished stream whose recording has a duration", async () => {
    probeReturning({ ...VIDEO, live_status: "post_live", duration: 600 });
    await expect(
      probeSource({ binary: "yt-dlp", url: URL, limits: LIMITS }),
    ).resolves.toMatchObject({ isLive: false, durationMs: 600_000 });
  });

  it("classifies a refused probe from its ERROR line", async () => {
    fakeDownloader(async (child) => {
      child.stderr.write("WARNING: [youtube] x: Some formats may be missing\n");
      child.stderr.write("ERROR: [youtube] x: Private video. Sign in if you've been granted access\n");
      await child.exit(1);
    });
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = await failure(probeSource({ binary: "yt-dlp", url: URL, limits: LIMITS }));
    expect(error).toMatchObject({ reason: "media/source_private", retryable: false });
  });

  it("gives an unreadable description a reason for when its retries run out", async () => {
    fakeDownloader(async (child) => {
      child.stdout.write("{not json");
      await child.exit(0);
    });
    const error = await failure(probeSource({ binary: "yt-dlp", url: URL, limits: LIMITS }));
    expect(error).toMatchObject({ retryable: true, reason: "media/source_failed" });
  });
});

describe("assertYtDlpUsable", () => {
  function reportingVersion(version: string): void {
    fakeDownloader(async (child) => {
      child.stdout.write(`${version}\n`);
      await child.exit(0);
    });
  }

  it("warns and carries on with another version only when the deployment allows it by name", async () => {
    // Refusing here kills the acquisition worker at boot the day pip moves
    // yt-dlp on, and every link run sits at "Add video" with every health
    // check green — so a package-manager deployment may opt out, on purpose.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    reportingVersion("2026.09.30");
    await expect(
      assertYtDlpUsable({ binary: "yt-dlp", verifyDigest: false, allowUnpinned: true }),
    ).resolves.toEqual({ version: "2026.09.30", sha256: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      version: "2026.09.30",
      pinned: EXPECTED_VERSION,
    });
  });

  it("keeps the pin with verification off, when nobody allowed otherwise", async () => {
    // WORKER_MEDIA_YT_DLP_VERIFY=0 says "there is no digest to check", not
    // "run whatever version is installed": ADR 0002 §7 still applies.
    reportingVersion("2026.09.30");
    const refused = assertYtDlpUsable({ binary: "yt-dlp", verifyDigest: false });
    await expect(refused).rejects.toBeInstanceOf(DownloaderUnusableError);
    await expect(refused).rejects.toThrow(/WORKER_MEDIA_YT_DLP_ALLOW_UNPINNED=1/);
  });

  it("still refuses another version when the digest is being verified, allowed or not", async () => {
    for (const allowUnpinned of [false, true]) {
      reportingVersion("2026.09.30");
      await expect(
        assertYtDlpUsable({ binary: "yt-dlp", verifyDigest: true, allowUnpinned }),
        String(allowUnpinned),
      ).rejects.toBeInstanceOf(DownloaderUnusableError);
    }
  });

  it("refuses a binary that reports no version at all, verification or not", async () => {
    for (const verifyDigest of [false, true]) {
      reportingVersion("");
      await expect(
        assertYtDlpUsable({ binary: "yt-dlp", verifyDigest }),
        String(verifyDigest),
      ).rejects.toThrow(/reports no version/);
    }
  });

  it("accepts the pinned release without a digest check when verification is off", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    reportingVersion(EXPECTED_VERSION);
    await expect(assertYtDlpUsable({ binary: "yt-dlp", verifyDigest: false })).resolves.toEqual({
      version: EXPECTED_VERSION,
      sha256: null,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
