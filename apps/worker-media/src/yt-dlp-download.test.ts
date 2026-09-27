import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
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

  it("chooses the streams against the job's time limit as well as its byte cap", async () => {
    // Three hours: 4K (5.6 GB) fits an 8 GiB plan, but not 40 minutes at the
    // assumed speed; given three hours to arrive, it would be the pick.
    const long = {
      ...VIDEO,
      duration: 3 * 60 * 60,
      formats: [
        { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", ext: "m4a", tbr: 129.476 },
        { format_id: "137", vcodec: "avc1.640028", acodec: "none", width: 1920, height: 1080, tbr: 1262.937 },
        { format_id: "401", vcodec: "av01.0.12M.08", acodec: "none", width: 3840, height: 2160, tbr: 3994.581 },
      ],
    };
    const limits = (timeoutMs: number): AcquireLimits => ({
      maxBytes: 8 * 1024 ** 3,
      maxDurationMs: 6 * 60 * 60 * 1000,
      timeoutMs,
    });
    probeReturning(long);
    await expect(
      probeSource({ binary: "yt-dlp", url: URL, limits: limits(40 * 60 * 1000) }),
    ).resolves.toMatchObject({ formatSelector: "137+140" });
    probeReturning(long);
    await expect(
      probeSource({ binary: "yt-dlp", url: URL, limits: limits(3 * 60 * 60 * 1000) }),
    ).resolves.toMatchObject({ formatSelector: "401+140" });
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
  const NODE = "C:/Program Files/nodejs/node.exe";

  /** yt-dlp's `-v` header, as the pinned venv prints it with node enabled. */
  function header(options: { runtimes?: string; libraries?: string } = {}): string {
    return [
      "[debug] yt-dlp version stable@2026.08.19 from yt-dlp/yt-dlp [594bd50c2] (pip)",
      `[debug] Optional libraries: ${options.libraries ?? "Cryptodome-3.23.0, certifi-2026.07.22, yt_dlp_ejs-0.8.0"}`,
      `[debug] JS runtimes: ${options.runtimes ?? "node-24.19.0"}`,
      "[debug] Plugin directories: none (disabled)",
      "[debug] Loaded 1744 extractors",
      "yt-dlp: error: You must provide at least one URL.",
    ].join("\n");
  }

  /** `--version` answers `version`; `-v` prints `debugHeader` to stderr and exits 2, as yt-dlp does. */
  function reportingVersion(
    version: string,
    debugHeader: string = header(),
  ): {
    readonly calls: (readonly string[])[];
  } {
    return fakeDownloader(async (child, args) => {
      if (args.includes("-v")) {
        child.stderr.write(`${debugHeader}\n`);
        await child.exit(2);
        return;
      }
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
      assertYtDlpUsable({
        binary: "yt-dlp",
        verifyDigest: false,
        allowUnpinned: true,
        jsRuntime: NODE,
      }),
    ).resolves.toEqual({
      version: "2026.09.30",
      sha256: null,
      ejsVersion: "0.8.0",
      jsRuntime: "node-24.19.0",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      version: "2026.09.30",
      pinned: EXPECTED_VERSION,
    });
  });

  it("boots on the pinned venv's own header, and says which runtime and solver it found", async () => {
    const { calls } = reportingVersion(EXPECTED_VERSION);
    await expect(
      assertYtDlpUsable({ binary: "yt-dlp", verifyDigest: false, jsRuntime: NODE }),
    ).resolves.toEqual({
      version: EXPECTED_VERSION,
      sha256: null,
      ejsVersion: "0.8.0",
      jsRuntime: "node-24.19.0",
    });
    // The header is asked for with the lock-down a real run uses, and no URL:
    // nothing is fetched at boot.
    const check = calls.find((args) => args.includes("-v")) ?? [];
    expect(check[check.indexOf("--js-runtimes") + 1]).toBe(`node:${NODE}`);
    expect(check).toContain("--no-js-runtimes");
    expect(check).toContain("--no-remote-components");
    expect(check).toContain("--no-plugin-dirs");
    expect(check.some((arg) => arg.startsWith("https://"))).toBe(false);
  });

  it("refuses to boot when the named node never shows up in yt-dlp's header", async () => {
    // A wrong path costs nothing visible: YouTube just falls back to one client,
    // until the day that client breaks too.
    reportingVersion(EXPECTED_VERSION, header({ runtimes: "none" }));
    await expect(
      assertYtDlpUsable({ binary: "yt-dlp", verifyDigest: false, jsRuntime: NODE }),
    ).rejects.toThrow(/YT_DLP_JS_RUNTIME names/);
  });

  it("refuses to boot with a runtime but no challenge solver installed", async () => {
    reportingVersion(
      EXPECTED_VERSION,
      header({ libraries: "Cryptodome-3.23.0, certifi-2026.07.22" }),
    );
    await expect(
      assertYtDlpUsable({ binary: "yt-dlp", verifyDigest: false, jsRuntime: NODE }),
    ).rejects.toThrow(/yt-dlp-ejs is not installed/);
  });

  it("boots with no runtime configured, and says what that costs", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    reportingVersion(EXPECTED_VERSION, header({ runtimes: "none (disabled)" }));
    await expect(assertYtDlpUsable({ binary: "yt-dlp", verifyDigest: false })).resolves.toEqual({
      version: EXPECTED_VERSION,
      sha256: null,
      ejsVersion: "0.8.0",
      jsRuntime: null,
    });
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/no JavaScript runtime/);
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

  it("reads the whole of the real header, with a line more than it has today", async () => {
    // The pinned venv's own `-v` output (14 lines; the version is 12th from
    // the end) plus one WARNING. Read through a 12-line tail, that one line
    // pushed the version out and the worker refused to boot for "no debug
    // header"; three more pushed out the solver as well.
    const real = [
      "[debug] Command-line config: ['-v', '--encoding', 'utf-8', '--ignore-config', '--no-cache-dir', '--no-js-runtimes', '--js-runtimes', 'node:C:/Program Files/nodejs/node.exe', '--no-remote-components', '--no-plugin-dirs']",
      "[debug] Encodings: locale cp1252, fs utf-8, pref utf-8, out cp1252 (No ANSI), error cp1252 (No ANSI), screen cp1252 (No ANSI)",
      "[debug] yt-dlp version stable@2026.08.19 from yt-dlp/yt-dlp [594bd50c2] (pip)",
      "[debug] Python 3.12.10 (CPython AMD64 64bit) - Windows-11-10.0.26200-SP0 (OpenSSL 3.0.16 11 Feb 2025)",
      "[debug] exe versions: ffmpeg 9.0-full_build-www.gyan.dev (setts), ffprobe 9.0-full_build-www.gyan.dev",
      "[debug] Optional libraries: Cryptodome-3.23.0, brotli-1.2.0, certifi-2026.07.22, mutagen-1.48.1, requests-2.34.2, sqlite3-3.49.1, urllib3-2.8.0, websockets-17.1, yt_dlp_ejs-0.8.0",
      "[debug] JS runtimes: node-24.19.0",
      "[debug] Proxy map: {}",
      "[debug] Request Handlers: urllib, requests, websockets",
      "[debug] Plugin directories: none (disabled)",
      "[debug] Loaded 1744 extractors",
      "WARNING: this Python version is deprecated and will stop being supported in a future release",
      "",
      "Usage: yt-dlp [OPTIONS] URL [URL...]",
      "",
      "yt-dlp: error: You must provide at least one URL.",
      "Type yt-dlp --help to see a list of all options.",
    ].join("\n");
    reportingVersion(EXPECTED_VERSION, real);
    await expect(
      assertYtDlpUsable({ binary: "yt-dlp", verifyDigest: false, jsRuntime: NODE }),
    ).resolves.toEqual({
      version: EXPECTED_VERSION,
      sha256: null,
      ejsVersion: "0.8.0",
      jsRuntime: "node-24.19.0",
    });
  });

  it("accepts the pinned release without a digest check when verification is off", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    reportingVersion(EXPECTED_VERSION);
    await expect(
      assertYtDlpUsable({ binary: "yt-dlp", verifyDigest: false, jsRuntime: NODE }),
    ).resolves.toEqual({
      version: EXPECTED_VERSION,
      sha256: null,
      ejsVersion: "0.8.0",
      jsRuntime: "node-24.19.0",
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("a section download", () => {
  it("asks for the section, and reports the bytes on disk as they land", async () => {
    const seen: number[] = [];
    const { calls } = fakeDownloader(async (child) => {
      await put("source.mp4.part", 300);
      await measurements(2);
      await put("source.mp4", 300);
      await child.exit(0);
    });
    await download({
      binary: "yt-dlp",
      url: URL,
      outputPath: output,
      limits: LIMITS,
      format: "137+140",
      section: { startMs: 60_000, endMs: 660_000 },
      sizeCheckIntervalMs: 10,
      onBytes: (bytes) => seen.push(bytes),
    });
    const args = calls[0] ?? [];
    expect(args[args.indexOf("--download-sections") + 1]).toBe("*60.000-660.000");
    expect(seen).toContain(300);
  });

  it("stops a section that misses its deadline, as a retryable failure the caller can answer", async () => {
    let child: FakeChild | undefined;
    fakeDownloader((started) => {
      child = started;
      // Starts the download, and never finishes it on its own.
      started.stdout.write(`[download] Destination: ${output}\n`);
    });
    const error = await failure(
      download({
        binary: "yt-dlp",
        url: URL,
        outputPath: output,
        limits: LIMITS,
        section: { startMs: 0, endMs: 600_000 },
        // A deadline of 30 ms from the download's start: no running time, a
        // 30 ms head start.
        pace: { mediaMs: 0, expectedBytes: null, minRealtime: 2, startupMs: 30 },
        sizeCheckIntervalMs: 10,
      }),
    );
    expect(error).toMatchObject({
      code: "media/acquire_slow",
      retryable: true,
      reason: "media/source_failed",
    });
    expect(child?.signals).toContain("SIGTERM");
  });

  it("stops a section whose bytes arrive slower than twice its running time", async () => {
    // One byte in a thousand of a one-minute section: 60 ms of video after
    // more than 30 ms, under 2x. The deadline (30 s) is nowhere near.
    fakeDownloader(async () => {
      await put("source.mp4.part", 1);
    });
    const error = await failure(
      download({
        binary: "yt-dlp",
        url: URL,
        outputPath: output,
        limits: LIMITS,
        section: { startMs: 0, endMs: 60_000 },
        pace: { mediaMs: 60_000, expectedBytes: 1_000, minRealtime: 2, startupMs: 0, warmupMs: 30 },
        sizeCheckIntervalMs: 10,
      }),
    );
    expect(error.code).toBe("media/acquire_slow");
  });

  it("lets a section that keeps its pace finish", async () => {
    // The control: 900 of 1 000 bytes is 54 s of a one-minute section, ahead
    // of 2x for the next 27 seconds.
    fakeDownloader(async (child) => {
      await put("source.mp4.part", 900);
      await measurements(5);
      await put("source.mp4", 900);
      await child.exit(0);
    });
    await download({
      binary: "yt-dlp",
      url: URL,
      outputPath: output,
      limits: { ...LIMITS, maxBytes: 10_000 },
      section: { startMs: 0, endMs: 60_000 },
      pace: { mediaMs: 60_000, expectedBytes: 1_000, minRealtime: 2, startupMs: 0, warmupMs: 30 },
      sizeCheckIntervalMs: 10,
    });
  });

  it("lets a finished section exit, after yt-dlp renamed its part and before it quit", async () => {
    // Between the rename of `source.mp4.part` to `source.mp4` and the exit,
    // the parts read as nothing (46-94 ms, measured on this host). Judged on
    // that, a finished, on-pace section was killed as slow, deleted, and the
    // whole video fetched instead.
    fakeDownloader(async (child) => {
      await put("source.mp4.part", 900);
      await measurements(4);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own temp directory
      await rename(join(dir, "source.mp4.part"), output);
      // Past the warm-up, several looks at a directory with no parts in it.
      await measurements(5);
      await child.exit(0);
    });
    await download({
      binary: "yt-dlp",
      url: URL,
      outputPath: output,
      limits: { ...LIMITS, maxBytes: 10_000 },
      section: { startMs: 0, endMs: 60_000 },
      pace: { mediaMs: 60_000, expectedBytes: 1_000, minRealtime: 2, startupMs: 0, warmupMs: 20 },
      sizeCheckIntervalMs: 10,
    });
  });

  it("judges the pace by ffmpeg's own time= when it prints one", async () => {
    // One byte of an estimated thousand is 60 ms of video by the average
    // bitrate, and slow; ffmpeg says 50 s have been written, which is not.
    fakeDownloader(async (child) => {
      await put("source.mp4.part", 1);
      for (let tick = 0; tick < 5; tick += 1) {
        child.stderr.write(
          "frame= 1500 fps=250 q=-1.0 size=       1KiB time=00:00:50.00 bitrate=   0.0kbits/s speed=8.3x\r",
        );
        await measurements(1);
      }
      await put("source.mp4", 1);
      await child.exit(0);
    });
    await download({
      binary: "yt-dlp",
      url: URL,
      outputPath: output,
      limits: LIMITS,
      section: { startMs: 0, endMs: 60_000 },
      pace: { mediaMs: 60_000, expectedBytes: 1_000, minRealtime: 2, startupMs: 0, warmupMs: 20 },
      sizeCheckIntervalMs: 10,
    });
  });

  it("starts the pace clock when the download starts, not while yt-dlp is still extracting", async () => {
    // Extraction, and YouTube's challenge solving with it, can take longer
    // than a short section's whole allowance (here 220 ms from the start).
    fakeDownloader(async (child) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      child.stdout.write(`[download] Destination: ${output}\n`);
      await put("source.mp4", 1);
      await child.exit(0);
    });
    await download({
      binary: "yt-dlp",
      url: URL,
      outputPath: output,
      limits: LIMITS,
      section: { startMs: 0, endMs: 40 },
      pace: { mediaMs: 40, expectedBytes: null, minRealtime: 2, startupMs: 200 },
      sizeCheckIntervalMs: 10,
    });
  });

  it("stops a download once the scratch volume is below its reserve", async () => {
    let child: FakeChild | undefined;
    fakeDownloader(async (started) => {
      child = started;
      started.stdout.write("[info] x: Downloading 1 time ranges: 0.0-60.0\n");
      // ffmpeg's stats, a few a second for as long as it runs: kept, they
      // would be all the operator's detail showed.
      for (let tick = 0; tick < 50; tick += 1) {
        started.stderr.write(
          `frame= ${String(tick)} fps=30 q=-1.0 size=  1KiB time=00:00:0${String(tick % 10)}.00 bitrate=1.0kbits/s speed=1x\r`,
        );
      }
      await put("source.f137.mp4.part", 10);
    });
    const error = await failure(
      download({
        binary: "yt-dlp",
        url: URL,
        outputPath: output,
        limits: LIMITS,
        lowDisk: async () => true,
        sizeCheckIntervalMs: 10,
      }),
    );
    expect(error).toMatchObject({
      code: "media/disk_full",
      retryable: true,
      reason: "media/source_failed",
    });
    expect(child?.signals).toContain("SIGTERM");
    expect(error.detail).toContain("Downloading 1 time ranges");
    expect(error.detail).not.toContain("frame=");
  });

  it("reads ffmpeg's 429 under a section download as a block, as the process prints it", async () => {
    fakeDownloader(async (child) => {
      child.stdout.write(`[download] Destination: ${output}\n`);
      for (let tick = 0; tick < 30; tick += 1) {
        child.stderr.write(
          `frame= ${String(tick)} fps=30 q=-1.0 size=  1KiB time=00:00:0${String(tick % 10)}.00 bitrate=1.0kbits/s speed=1x\r`,
        );
      }
      child.stderr.write("[https @ 000001d3c4a8f2c0] HTTP error 429 Too Many Requests\n");
      child.stderr.write("ERROR: ffmpeg exited with code 1\n");
      await child.exit(1);
    });
    const error = await failure(
      download({
        binary: "yt-dlp",
        url: URL,
        outputPath: output,
        limits: LIMITS,
        section: { startMs: 0, endMs: 60_000 },
      }),
    );
    expect(error).toMatchObject({ reason: "media/source_blocked", retryable: false });
    expect(error.detail).toContain("HTTP error 429");
  });

  it("says how many bytes it had when it killed a download for the cap", async () => {
    fakeDownloader(async () => {
      await put("source.f625.mp4.part", 1_200);
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
    expect(error.facts).toEqual({ approximateBytes: 1_200, maxBytes: 1_000 });
  });
});

describe("probeSource with a window", () => {
  /** Three hours; the real bitrates of youtube 5eW6Eagr9XA. */
  const THREE_HOURS = {
    id: "x",
    title: "A long talk",
    extractor_key: "Youtube",
    duration: 3 * 60 * 60,
    formats: [
      { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", ext: "m4a", tbr: 129.476 },
      { format_id: "137", vcodec: "avc1.640028", acodec: "none", width: 1920, height: 1080, tbr: 1262.937 },
      { format_id: "401", vcodec: "av01.0.12M.08", acodec: "none", width: 3840, height: 2160, tbr: 3994.581 },
    ],
  };
  /** The 12-hour source ceiling a window job carries, and a large plan's bytes. */
  const WINDOWED: AcquireLimits = {
    maxBytes: 8 * 1024 ** 3,
    maxDurationMs: 12 * 60 * 60 * 1000,
    timeoutMs: 40 * 60 * 1000,
  };

  function probeReturning(dump: Record<string, unknown>): void {
    fakeDownloader(async (child) => {
      child.stdout.write(JSON.stringify(dump));
      await child.exit(0);
    });
  }

  it("plans a section of a long source, and budgets the bytes for the section alone", async () => {
    // Twenty minutes of the three hours: 4K fits (619 MB) where the whole
    // video in 4K (5.6 GB) would not arrive in time, so the section is 4K and
    // the whole-file fallback is 1080p.
    probeReturning(THREE_HOURS);
    const metadata = await probeSource({
      binary: "yt-dlp",
      url: URL,
      limits: WINDOWED,
      window: { maxMs: 1_200_000, policy: "first" },
    });
    expect(metadata.section).toEqual({
      startMs: 0,
      endMs: 1_200_000,
      sourceDurationMs: 10_800_000,
      policy: "first",
    });
    expect(metadata.formatSelector).toBe("401+140");
    expect(metadata.wholeFormatSelector).toBe("137+140");
    expect(metadata.approximateBytes).toBeGreaterThan(600_000_000);
    expect(metadata.approximateBytes).toBeLessThan(650_000_000);
    expect(metadata.wholeBytes).toBeGreaterThan(1_800_000_000);
  });

  it("no longer refuses a video longer than the plan's minutes: it takes a window of it", async () => {
    // The Free plan: 20 minutes, 500 MB. Without a window this is too_long.
    probeReturning(THREE_HOURS);
    const free = { maxBytes: 524_288_000, maxDurationMs: 1_200_000, timeoutMs: 40 * 60 * 1000 };
    const refused = await failure(probeSource({ binary: "yt-dlp", url: URL, limits: free }));
    expect(refused).toMatchObject({
      reason: "media/too_long",
      facts: { durationMs: 10_800_000, maxDurationMs: 1_200_000 },
    });
    probeReturning(THREE_HOURS);
    const metadata = await probeSource({
      binary: "yt-dlp",
      url: URL,
      limits: { ...free, maxDurationMs: WINDOWED.maxDurationMs },
      window: { maxMs: 1_200_000, policy: "first" },
    });
    // 1080p H.264 of twenty minutes is 209 MB, inside the Free plan's bytes.
    expect(metadata.formatSelector).toBe("137+140");
    expect(metadata.approximateBytes).toBeLessThan(524_288_000 * 0.9);
  });

  it("centres the section on the heatmap's peak", async () => {
    probeReturning({
      ...THREE_HOURS,
      heatmap: [
        { start_time: 0, end_time: 108, value: 0.3 },
        { start_time: 5_400, end_time: 5_508, value: 1 },
      ],
    });
    const metadata = await probeSource({
      binary: "yt-dlp",
      url: URL,
      limits: WINDOWED,
      window: { maxMs: 1_200_000, policy: "most_replayed" },
    });
    // Peak centred at 1:30:54; twenty minutes around it.
    expect(metadata.section).toMatchObject({
      startMs: 5_454_000 - 600_000,
      endMs: 5_454_000 + 600_000,
      policy: "most_replayed",
    });
    expect(metadata.replayedPeakMs).toBe(5_454_000);
  });

  it("plans nothing for a source that fits the window", async () => {
    probeReturning({ ...THREE_HOURS, duration: 600 });
    const metadata = await probeSource({
      binary: "yt-dlp",
      url: URL,
      limits: WINDOWED,
      window: { maxMs: 1_200_000, policy: "first" },
    });
    expect(metadata.section).toBeNull();
    expect(metadata.wholeFormatSelector).toBe(metadata.formatSelector);
  });

  it("passes the JavaScript runtime to the metadata step", async () => {
    const { calls } = fakeDownloader(async (child) => {
      child.stdout.write(JSON.stringify(THREE_HOURS));
      await child.exit(0);
    });
    await probeSource({
      binary: "yt-dlp",
      url: URL,
      limits: WINDOWED,
      jsRuntime: "C:/Program Files/nodejs/node.exe",
    });
    const args = calls[0] ?? [];
    expect(args[args.indexOf("--js-runtimes") + 1]).toBe("node:C:/Program Files/nodejs/node.exe");
  });
});
