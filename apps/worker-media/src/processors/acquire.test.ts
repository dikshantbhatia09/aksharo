import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaJobError } from "../errors.js";
import { processAcquire } from "./acquire.js";

import type { JobContext } from "../runtime.js";
import type { Settings } from "../settings.js";
import type { ChildProcess } from "node:child_process";

/**
 * `media.acquire` from the processor's side: what it refuses before anything
 * runs, and what it makes of the downloader's answers. The downloader is a fake
 * process (see `yt-dlp-download.test.ts` for the process-level rules); the
 * scratch directory is real.
 */

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): boolean {
    void this.exit(null);
    return true;
  }

  async exit(code: number | null): Promise<void> {
    const drained = Promise.all([once(this.stdout, "end"), once(this.stderr, "end")]);
    this.stdout.end();
    this.stderr.end();
    await drained;
    this.emit("close", code, null);
  }
}

/** The probe answers with `dump`; the download runs `onDownload`. */
function fakeYtDlp(
  dump: Record<string, unknown>,
  onDownload: (child: FakeChild) => Promise<void>,
): { readonly downloads: (readonly string[])[] } {
  const downloads: (readonly string[])[] = [];
  spawnMock.mockImplementation(((_binary: string, args: readonly string[]) => {
    const child = new FakeChild();
    setImmediate(() => {
      if (args.includes("--dump-single-json")) {
        child.stdout.write(JSON.stringify(dump));
        void child.exit(0);
        return;
      }
      downloads.push(args);
      void onDownload(child);
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn);
  return { downloads };
}

const DUMP = {
  id: "5eW6Eagr9XA",
  title: "An 18-minute talk",
  extractor_key: "Youtube",
  duration: 1078,
  formats: [
    { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", ext: "m4a", filesize: 17_452_022 },
    { format_id: "137", vcodec: "avc1.640028", acodec: "none", height: 1080, filesize: 170_219_237 },
  ],
};

function context(
  source: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
): JobContext & { readonly reported: number[] } {
  const reported: number[] = [];
  const payload = {
    runId: "01JCRUN0000000000000000000",
    projectId: "01JCPR0JECT000000000000000",
    mediaId: "01JCMED1A00000000000000000",
    source: {
      kind: "youtube_url",
      normalizedUrl: "https://www.youtube.com/watch?v=5eW6Eagr9XA",
      sourceId: "5eW6Eagr9XA",
      ...source,
    },
    destination: { bucket: "montaj-raw", key: "ws/W/p/P/media/M/raw.mp4" },
    limits: { maxBytes: 524_288_000, maxDurationMs: 1_200_000, timeoutMs: 60_000 },
  };
  return {
    reported,
    settings: {
      ytDlpPath: "yt-dlp",
      ffmpegPath: "C:/tools/ffmpeg/bin/ffmpeg.exe",
      ffprobePath: "ffprobe",
      tempDir: undefined,
      ffmpegTimeoutMs: 60_000,
      ...settings,
    } as unknown as Settings,
    envelope: { payload } as unknown as JobContext["envelope"],
    payload: payload as unknown as JobContext["payload"],
    derivedPrefix: "ws/W/p/P/media/M",
    raw: {} as JobContext["raw"],
    derived: {} as JobContext["derived"],
    callbacks: {} as JobContext["callbacks"],
    report: (progress) => {
      reported.push(progress);
    },
    signal: new AbortController().signal,
  };
}

async function failure(promise: Promise<unknown>): Promise<MediaJobError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MediaJobError);
  return error as MediaJobError;
}

afterEach(() => {
  spawnMock.mockReset();
});

describe("processAcquire", () => {
  it("refuses a direct media link before running anything", async () => {
    // The API refuses these at creation because there is no egress policy yet;
    // a replayed or hand-built job must not get round that here.
    fakeYtDlp(DUMP, async (child) => child.exit(0));
    const error = await failure(
      processAcquire(
        context({ kind: "direct_media_url", normalizedUrl: "https://cdn.example.test/v.mp4" }),
      ),
    );
    expect(error).toMatchObject({ reason: "media/unsupported", retryable: false });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a host that is not YouTube before running anything", async () => {
    fakeYtDlp(DUMP, async (child) => child.exit(0));
    for (const normalizedUrl of [
      "https://example.test/watch?v=x",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      const error = await failure(processAcquire(context({ normalizedUrl })));
      expect(error.reason, normalizedUrl).toBe("media/unsupported");
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a redirect, or any path but one video, on YouTube's own host", async () => {
    // The API only ever sends /watch?v=<id>. Anything else on an allowed host
    // is a replayed or hand-built payload, and some of those paths redirect.
    fakeYtDlp(DUMP, async (child) => child.exit(0));
    for (const normalizedUrl of [
      "https://www.youtube.com/redirect?q=http%3A%2F%2F169.254.169.254%2F",
      "https://www.youtube.com/attribution_link?u=%2Fwatch%3Fv%3D5eW6Eagr9XA",
    ]) {
      const error = await failure(processAcquire(context({ normalizedUrl })));
      expect(error.reason, normalizedUrl).toBe("media/unsupported");
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("merges with the ffmpeg found on PATH when FFMPEG_PATH is only a name", async () => {
    // yt-dlp reads a bare `ffmpeg` as a missing file, so production — which
    // sets no FFMPEG_PATH — never passed --ffmpeg-location at all.
    const { downloads } = fakeYtDlp(DUMP, async (child) => {
      child.stderr.write("ERROR: [youtube] x: Video unavailable\n");
      await child.exit(1);
    });
    await failure(
      processAcquire(
        context({}, { ffmpegPath: "ffmpeg", ffmpegLocation: "C:/ffmpeg-9/bin/ffmpeg.exe" }),
      ),
    );
    const args = downloads[0] ?? [];
    expect(args[args.indexOf("--ffmpeg-location") + 1]).toBe("C:/ffmpeg-9/bin/ffmpeg.exe");
  });

  it("ends a max-filesize abort as too_large on the first attempt, never as ENOENT", async () => {
    // The 2026-09-25 shape: yt-dlp prints the abort to stdout and exits 0
    // with no merged file; the worker then stat()ed a file that was not there.
    fakeYtDlp(DUMP, async (child) => {
      child.stdout.write(
        "[download] File is larger than max-filesize (538391240 bytes > 524288000 bytes). Aborting.\n",
      );
      await child.exit(0);
    });
    const error = await failure(processAcquire(context()));
    expect(error).toMatchObject({
      reason: "media/too_large",
      code: "media/too_large",
      retryable: false,
    });
  });

  it("downloads the chosen streams, merging with the configured ffmpeg", async () => {
    const { downloads } = fakeYtDlp(DUMP, async (child) => {
      child.stderr.write("ERROR: [youtube] x: Video unavailable\n");
      await child.exit(1);
    });
    const error = await failure(processAcquire(context()));
    expect(error.reason).toBe("media/source_removed");
    const args = downloads[0] ?? [];
    expect(args[args.indexOf("-f") + 1]).toBe("137+140");
    expect(args[args.indexOf("--ffmpeg-location") + 1]).toBe("C:/tools/ffmpeg/bin/ffmpeg.exe");
  });

  it("moves the progress rail forward only, through a split download's two parts", async () => {
    fakeYtDlp(DUMP, async (child) => {
      for (const line of [
        "[download] Destination: source.f137.mp4",
        "[download]  40.0% of  162.33MiB",
        "[download] 100.0% of  162.33MiB",
        "[download] Destination: source.f140.m4a",
        "[download]  10.0% of   16.64MiB",
        "[download] 100.0% of   16.64MiB",
      ]) {
        child.stdout.write(`${line}\n`);
      }
      // No file and nothing said: the processor stops after the download.
      await child.exit(0);
    });
    const ctx = context();
    await failure(processAcquire(ctx));
    // 2 (checking) and 5 (starting), then the download mapped onto 5-70.
    expect(ctx.reported).toEqual([2, 5, 31, 70, 70, 70]);
  });
});
