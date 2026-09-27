import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DiskGuard } from "../disk.js";
import { MediaJobError, transientFailure } from "../errors.js";
import { logger } from "../logger.js";
import { download } from "../yt-dlp.js";
import { placeLanded, processAcquire, sha256 } from "./acquire.js";

import type { JobContext } from "../runtime.js";
import type { Settings } from "../settings.js";
import type * as YtDlp from "../yt-dlp.js";
import type { ChildProcess } from "node:child_process";
import type * as FsPromises from "node:fs/promises";

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

// The real rm, watched: a test makes it fail for one directory, as Windows
// does for a file another process still holds open.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, rm: vi.fn(actual["rm"] as (...args: unknown[]) => unknown) };
});

// The real downloader, watched: what the processor asks of it (a pace, a
// section) is not visible in the argument list.
vi.mock("../yt-dlp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof YtDlp>();
  return { ...actual, download: vi.fn(actual.download) };
});

const spawnMock = vi.mocked(spawn);
const downloadMock = vi.mocked(download);
const rmMock = vi.mocked(rm);

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

/**
 * The probe answers with `dump`; the download runs `onDownload`. ffprobe of
 * what landed runs `onFfprobe` (none given: it fails), and `--version` answers
 * the pinned release.
 */
function fakeYtDlp(
  dump: Record<string, unknown>,
  onDownload: (child: FakeChild, args: readonly string[]) => Promise<void>,
  onFfprobe?: (child: FakeChild) => Promise<void>,
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
      if (args.includes("-show_streams")) {
        void (onFfprobe?.(child) ?? child.exit(1));
        return;
      }
      if (args.includes("--version")) {
        child.stdout.write("2026.08.19\n");
        void child.exit(0);
        return;
      }
      downloads.push(args);
      void onDownload(child, args);
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn);
  return { downloads };
}

/** A download that lands a small file where it was told to, and exits 0. */
async function landFile(child: FakeChild, args: readonly string[]): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the `-o` path the processor built inside its own scratch directory
  await writeFile(args[args.indexOf("-o") + 1] ?? "", Buffer.alloc(4_096, 1));
  await child.exit(0);
}

/** ffprobe's answer for an ordinary 18-minute 1080p file. */
const PROBED = {
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      avg_frame_rate: "30/1",
    },
    { index: 1, codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "44100" },
  ],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1078.0", size: "4096" },
};

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
  extra: Record<string, unknown> = {},
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
    ...extra,
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
  // Calls only: the real downloader and rm stay behind their spies.
  downloadMock.mockClear();
  rmMock.mockClear();
  vi.restoreAllMocks();
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

  it("stores what landed when nothing stopped it", async () => {
    // The control for the next test: the same flow reaches the upload.
    fakeYtDlp(DUMP, landFile, async (child) => {
      child.stdout.write(JSON.stringify(PROBED));
      await child.exit(0);
    });
    const putFile = vi.fn(async () => 4_096);
    const outcome = await processAcquire({
      ...context(),
      raw: { putFile } as unknown as JobContext["raw"],
    });
    expect(putFile).toHaveBeenCalledTimes(1);
    expect(outcome.result).toMatchObject({ sizeBytes: 4_096, key: "ws/W/p/P/media/M/raw.mp4" });
  });

  it("neither hashes nor uploads a download whose run was stopped after the bytes landed", async () => {
    // Nothing kills an upload, and the stop arrived after the downloader and
    // ffprobe had both finished: stored, the file would sit in raw under a
    // media row the API has already failed, with no scheduler to purge it.
    const stop = new AbortController();
    fakeYtDlp(DUMP, landFile, async (child) => {
      child.stdout.write(JSON.stringify(PROBED));
      await child.exit(0);
      stop.abort("already_completed");
    });
    const putFile = vi.fn(async () => 4_096);
    const ctx = context();
    const error = await failure(
      processAcquire({
        ...ctx,
        raw: { putFile } as unknown as JobContext["raw"],
        signal: stop.signal,
      }),
    );
    expect(putFile).not.toHaveBeenCalled();
    // Not even hashed: 85 is "saving your video", which starts with the hash —
    // on a paid plan's multi-gigabyte file, a minute of the shared slot.
    expect(ctx.reported).not.toContain(85);
    // Retryable, so a shutdown runs it again; the runtime ends a stopped run's
    // job without reporting it (runtime.test.ts).
    expect(error).toMatchObject({ code: "media/cancelled", retryable: true });
    expect(error.message).toBe("the download was stopped before it was saved");
  });
});

describe("processAcquire with a window", () => {
  /**
   * Every tool this path runs, faked by what it is asked: the metadata, the
   * downloads (in order), ffprobe (answering `durationOf` the file it is
   * pointed at) and the local cut (which writes its output).
   */
  function fakeTools(input: {
    readonly dump?: Record<string, unknown>;
    readonly onDownload: (
      child: FakeChild,
      args: readonly string[],
      index: number,
    ) => Promise<void>;
    readonly durationOf: (path: string) => number;
  }): {
    readonly downloads: (readonly string[])[];
    readonly cuts: (readonly string[])[];
    readonly probes: (readonly string[])[];
  } {
    const downloads: (readonly string[])[] = [];
    const cuts: (readonly string[])[] = [];
    const probes: (readonly string[])[] = [];
    spawnMock.mockImplementation(((_binary: string, args: readonly string[]) => {
      const child = new FakeChild();
      setImmediate(() => {
        if (args.includes("--dump-single-json")) {
          probes.push(args);
          child.stdout.write(JSON.stringify(input.dump ?? DUMP));
          void child.exit(0);
        } else if (args.includes("-show_streams")) {
          const seconds = input.durationOf(args.at(-1) ?? "");
          child.stdout.write(
            JSON.stringify({ ...PROBED, format: { ...PROBED.format, duration: String(seconds) } }),
          );
          void child.exit(0);
        } else if (args.includes("--version")) {
          child.stdout.write("2026.08.19\n");
          void child.exit(0);
        } else if (args.includes("-avoid_negative_ts")) {
          cuts.push(args);
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- the cut's output, inside the processor's scratch directory
          void writeFile(args.at(-1) ?? "", Buffer.alloc(2_048, 2)).then(async () => child.exit(0));
        } else {
          downloads.push(args);
          void input.onDownload(child, args, downloads.length - 1);
        }
      });
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn);
    return { downloads, cuts, probes };
  }

  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  /** The window job's limits: the 12-hour source ceiling, and the real 40-minute time limit. */
  const LIMITS = { maxBytes: 524_288_000, maxDurationMs: TWELVE_HOURS, timeoutMs: 2_400_000 };
  const TEN_MINUTES = { maxMs: 600_000, policy: "first" };

  /** The section lands 600 s long; any other file is the 1078 s source; the cut is 600 s. */
  const durationOf = (path: string): number =>
    path.includes(`${sep}section${sep}`) || path.endsWith("window.mp4") ? 600 : 1078;

  function uploaded(): {
    readonly putFile: ReturnType<typeof vi.fn>;
    readonly raw: JobContext["raw"];
  } {
    const putFile = vi.fn(async () => 4_096);
    return { putFile, raw: { putFile } as unknown as JobContext["raw"] };
  }

  it("fetches only the window of a longer video, and says where it sits", async () => {
    const { downloads, cuts } = fakeTools({ onDownload: landFile, durationOf });
    const { putFile, raw } = uploaded();
    const outcome = await processAcquire({
      ...context({}, {}, { limits: LIMITS, window: TEN_MINUTES }),
      raw,
    });
    const args = downloads[0] ?? [];
    expect(args[args.indexOf("--download-sections") + 1]).toBe("*0.000-600.000");
    // In its own directory, so a fallback never counts its leftovers.
    expect(args[args.indexOf("-o") + 1]).toContain(`${sep}section${sep}`);
    expect(downloads).toHaveLength(1);
    expect(cuts).toHaveLength(0);
    expect(outcome.result["section"]).toEqual({
      startMs: 0,
      endMs: 600_000,
      sourceDurationMs: 1_078_000,
      policy: "first",
    });
    expect(outcome.mediaPatch).toMatchObject({ durationMs: 600_000 });
    expect(putFile).toHaveBeenCalledTimes(1);
  });

  it("downloads a video that fits its window whole, and reports no section", async () => {
    const { downloads } = fakeTools({ onDownload: landFile, durationOf: () => 1078 });
    const outcome = await processAcquire({
      ...context({}, {}, { limits: LIMITS, window: { maxMs: 1_200_000, policy: "most_replayed" } }),
      raw: uploaded().raw,
    });
    expect(downloads[0]).not.toContain("--download-sections");
    expect(outcome.result).not.toHaveProperty("section");
  });

  it("centres the window on YouTube's most-replayed moment", async () => {
    const { downloads } = fakeTools({
      dump: { ...DUMP, heatmap: [{ start_time: 700, end_time: 710, value: 1 }] },
      onDownload: landFile,
      durationOf,
    });
    const outcome = await processAcquire({
      ...context({}, {}, { limits: LIMITS, window: { maxMs: 600_000, policy: "most_replayed" } }),
      raw: uploaded().raw,
    });
    const args = downloads[0] ?? [];
    // Peak at 11:45: 6:45-16:45.
    expect(args[args.indexOf("--download-sections") + 1]).toBe("*405.000-1005.000");
    expect(outcome.result["section"]).toMatchObject({ startMs: 405_000, policy: "most_replayed" });
  });

  it("fetches the whole video and cuts the window here when the section download fails", async () => {
    const { downloads, cuts } = fakeTools({
      onDownload: async (child, args, index) => {
        if (index === 0) {
          child.stderr.write("ERROR: [download] This format cannot be partially downloaded\n");
          await child.exit(1);
          return;
        }
        await landFile(child, args);
      },
      durationOf,
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { putFile, raw } = uploaded();
    const outcome = await processAcquire({
      ...context({}, {}, { limits: LIMITS, window: TEN_MINUTES }),
      raw,
    });
    expect(downloads).toHaveLength(2);
    expect(downloads[1]).not.toContain("--download-sections");
    const cut = cuts[0] ?? [];
    expect(cut[cut.indexOf("-ss") + 1]).toBe("0.000");
    expect(cut[cut.indexOf("-t") + 1]).toBe("600.000");
    expect(cut[cut.indexOf("-c") + 1]).toBe("copy");
    expect(outcome.result["section"]).toMatchObject({ startMs: 0, endMs: 600_000 });
    // What is stored is the cut, not the whole video.
    expect(putFile).toHaveBeenCalledWith(
      expect.objectContaining({ file: expect.stringMatching(/window\.mp4$/) }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/fetching the whole video/),
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("does not fetch the whole video when it would not fit the plan; it fails to be retried", async () => {
    // 150 MB: the ten-minute section (104 MB) fits, the whole video (188 MB) does not.
    const { downloads } = fakeTools({
      onDownload: async (child) => {
        child.stderr.write("ERROR: [download] This format cannot be partially downloaded\n");
        await child.exit(1);
      },
      durationOf,
    });
    const error = await failure(
      processAcquire(
        context({}, {}, { limits: { ...LIMITS, maxBytes: 150_000_000 }, window: TEN_MINUTES }),
      ),
    );
    expect(error).toMatchObject({
      code: "media/acquire_section_failed",
      retryable: true,
      reason: "media/source_failed",
    });
    expect(downloads).toHaveLength(1);
  });

  it("holds a section to its pace only when fetching the whole video is the faster road", async () => {
    // With no fallback, a slow section that finishes beats a failed run.
    fakeTools({ onDownload: landFile, durationOf });
    await processAcquire({
      ...context({}, {}, { limits: LIMITS, window: TEN_MINUTES }),
      raw: uploaded().raw,
    });
    expect(downloadMock.mock.calls[0]?.[0].pace).toMatchObject({
      mediaMs: 600_000,
      minRealtime: 2,
      expectedBytes: expect.any(Number),
    });

    downloadMock.mockClear();
    fakeTools({ onDownload: landFile, durationOf });
    await processAcquire({
      ...context({}, {}, { limits: { ...LIMITS, maxBytes: 150_000_000 }, window: TEN_MINUTES }),
      raw: uploaded().raw,
    });
    expect(downloadMock.mock.calls[0]?.[0].section).toMatchObject({ startMs: 0, endMs: 600_000 });
    expect(downloadMock.mock.calls[0]?.[0].pace).toBeUndefined();
  });

  it("does not fall back from a refusal that names the video", async () => {
    // Removed is removed for the whole file too, and a block is made worse by asking again.
    const { downloads } = fakeTools({
      onDownload: async (child) => {
        child.stderr.write("ERROR: [youtube] x: Video unavailable\n");
        await child.exit(1);
      },
      durationOf,
    });
    const error = await failure(
      processAcquire(context({}, {}, { limits: LIMITS, window: TEN_MINUTES })),
    );
    expect(error.reason).toBe("media/source_removed");
    expect(downloads).toHaveLength(1);
  });

  it("cuts a whole file that came back longer than its window", async () => {
    // The source did not say how long it was, so nothing could be planned
    // before the download; the file itself says.
    const { downloads, cuts } = fakeTools({
      dump: { ...DUMP, duration: undefined },
      onDownload: landFile,
      durationOf,
    });
    const outcome = await processAcquire({
      ...context({}, {}, { limits: LIMITS, window: TEN_MINUTES }),
      raw: uploaded().raw,
    });
    expect(downloads[0]).not.toContain("--download-sections");
    expect(cuts).toHaveLength(1);
    expect(outcome.result["section"]).toEqual({
      startMs: 0,
      endMs: 600_000,
      sourceDurationMs: 1_078_000,
      policy: "first",
    });
    expect(outcome.mediaPatch).toMatchObject({ durationMs: 600_000 });
  });

  it("refuses a malformed window before running anything", async () => {
    fakeTools({ onDownload: landFile, durationOf });
    const error = await failure(
      processAcquire(context({}, {}, { limits: LIMITS, window: { maxMs: -1, policy: "first" } })),
    );
    expect(error).toMatchObject({ code: "media/bad_payload", retryable: false });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("gives the metadata step and the download the same JavaScript runtime", async () => {
    const node = "C:/Program Files/nodejs/node.exe";
    const { downloads, probes } = fakeTools({ onDownload: landFile, durationOf });
    await processAcquire({
      ...context({}, { ytDlpJsRuntime: node }, { limits: LIMITS, window: TEN_MINUTES }),
      raw: uploaded().raw,
    });
    for (const args of [probes[0] ?? [], downloads[0] ?? []]) {
      expect(args[args.indexOf("--js-runtimes") + 1]).toBe(`node:${node}`);
    }
  });

  it("refuses a landed file over the byte cap with both numbers", async () => {
    // A source that gave no sizes, so the metadata could not refuse it first.
    fakeTools({
      dump: {
        ...DUMP,
        formats: [
          { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", ext: "m4a" },
          { format_id: "137", vcodec: "avc1.640028", acodec: "none", height: 1080 },
        ],
      },
      onDownload: landFile,
      durationOf,
    });
    const error = await failure(
      processAcquire(context({}, {}, { limits: { ...LIMITS, maxBytes: 1_000 } })),
    );
    expect(error).toMatchObject({
      reason: "media/too_large",
      facts: { approximateBytes: 4_096, maxBytes: 1_000 },
    });
  });

  /** A section download that fails for a reason nobody named. */
  const failFirst =
    (then: (child: FakeChild, args: readonly string[]) => Promise<void> = landFile) =>
    async (child: FakeChild, args: readonly string[], index: number): Promise<void> => {
      if (index === 0) {
        child.stderr.write("ERROR: [download] This format cannot be partially downloaded\n");
        await child.exit(1);
        return;
      }
      await then(child, args);
    };

  it("reports the whole source, not the plan's part of it, when the whole video is short enough to keep", async () => {
    // 10:10 against a ten-minute window, its most-replayed moment late: the
    // plan is 0:10-10:10. The section fails, the whole video lands, and at
    // 10 s over the window it is kept whole — so it must not be reported as
    // starting at 0:10, which put the next window 10 s off.
    const { cuts } = fakeTools({
      dump: { ...DUMP, duration: 610, heatmap: [{ start_time: 500, end_time: 510, value: 1 }] },
      onDownload: failFirst(),
      durationOf: () => 610,
    });
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const outcome = await processAcquire({
      ...context({}, {}, { limits: LIMITS, window: { maxMs: 600_000, policy: "most_replayed" } }),
      raw: uploaded().raw,
    });
    expect(downloadMock.mock.calls[0]?.[0].section).toMatchObject({ startMs: 10_000 });
    expect(cuts).toHaveLength(0);
    expect(outcome.result).not.toHaveProperty("section");
    expect(outcome.mediaPatch).toMatchObject({ durationMs: 610_000 });
  });

  it("fetches the whole video instead of a section that runs too slowly", async () => {
    downloadMock.mockImplementationOnce(async () => {
      throw transientFailure("media/acquire_slow", "the section arrived slower than 2x");
    });
    const { downloads, cuts } = fakeTools({ onDownload: landFile, durationOf });
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const outcome = await processAcquire({
      ...context({}, {}, { limits: LIMITS, window: TEN_MINUTES }),
      raw: uploaded().raw,
    });
    // The spawned download is the whole video; the section never ran.
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).not.toContain("--download-sections");
    expect(cuts).toHaveLength(1);
    expect(outcome.result["section"]).toMatchObject({ startMs: 0, endMs: 600_000 });
  });

  it("does not start the whole video with too little of the job's time left for it", async () => {
    // Thirty seconds of time limit: the section failed, and the whole video
    // cannot arrive in what is left. A retry gets a fresh limit.
    const { downloads } = fakeTools({ onDownload: failFirst(), durationOf });
    const error = await failure(
      processAcquire(
        context({}, {}, { limits: { ...LIMITS, timeoutMs: 30_000 }, window: TEN_MINUTES }),
      ),
    );
    expect(error).toMatchObject({ code: "media/acquire_section_failed", retryable: true });
    expect(error.message).toMatch(/no time left/);
    expect(downloads).toHaveLength(1);
  });

  it("refuses a section download that is neither the section nor the whole video", async () => {
    // 800 s: longer than the window, shorter than the 1078 s source. Where it
    // sits in the video nobody here knows, so no cut of it can be trusted.
    fakeTools({
      onDownload: landFile,
      durationOf: (path) => (path.includes(`${sep}section${sep}`) ? 800 : 1078),
    });
    const error = await failure(
      processAcquire(context({}, {}, { limits: LIMITS, window: TEN_MINUTES })),
    );
    expect(error).toMatchObject({ code: "media/acquire_section_mismatch", retryable: true });
  });

  it("cuts the window out of a section download that ignored the section", async () => {
    // The whole 1078 s source arrived where ten minutes were asked for.
    const { cuts } = fakeTools({
      onDownload: landFile,
      durationOf: (path) => (path.endsWith("window.mp4") ? 600 : 1078),
    });
    const outcome = await processAcquire({
      ...context({}, {}, { limits: LIMITS, window: TEN_MINUTES }),
      raw: uploaded().raw,
    });
    expect(cuts).toHaveLength(1);
    expect(outcome.result["section"]).toMatchObject({ startMs: 0, endMs: 600_000 });
  });

  it("fails a cut that did not come out the length it should", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    fakeTools({
      onDownload: failFirst(),
      durationOf: (path) => (path.endsWith("window.mp4") ? 100 : 1078),
    });
    const error = await failure(
      processAcquire(context({}, {}, { limits: LIMITS, window: TEN_MINUTES })),
    );
    expect(error).toMatchObject({ code: "media/acquire_trim_failed", retryable: true });
  });

  it("fetches the range the user chose", async () => {
    const { downloads } = fakeTools({ onDownload: landFile, durationOf });
    const outcome = await processAcquire({
      ...context(
        {},
        {},
        { limits: LIMITS, window: { maxMs: 600_000, startMs: 300_000, policy: "range" } },
      ),
      raw: uploaded().raw,
    });
    const args = downloads[0] ?? [];
    expect(args[args.indexOf("--download-sections") + 1]).toBe("*300.000-900.000");
    expect(outcome.result["section"]).toEqual({
      startMs: 300_000,
      endMs: 900_000,
      sourceDurationMs: 1_078_000,
      policy: "range",
    });
  });

  it("says where a section that came back short really ends, and refuses one under half", async () => {
    // A reader that lost its connection writes a short file and exits 0.
    fakeTools({
      onDownload: landFile,
      durationOf: (path) => (path.includes(`${sep}section${sep}`) ? 400 : 1078),
    });
    const outcome = await processAcquire({
      ...context({}, {}, { limits: LIMITS, window: TEN_MINUTES }),
      raw: uploaded().raw,
    });
    expect(outcome.result["section"]).toMatchObject({ startMs: 0, endMs: 400_000 });

    fakeTools({
      onDownload: landFile,
      durationOf: (path) => (path.includes(`${sep}section${sep}`) ? 200 : 1078),
    });
    const error = await failure(
      processAcquire(context({}, {}, { limits: LIMITS, window: TEN_MINUTES })),
    );
    expect(error).toMatchObject({ code: "media/acquire_section_short", retryable: true });
  });

  it("does not fall back from a section YouTube refused through ffmpeg's reader", async () => {
    const { downloads } = fakeTools({
      onDownload: async (child) => {
        child.stderr.write("[https @ 000001d3c4a8f2c0] HTTP error 429 Too Many Requests\n");
        child.stderr.write("ERROR: ffmpeg exited with code 1\n");
        await child.exit(1);
      },
      durationOf,
    });
    const error = await failure(
      processAcquire(context({}, {}, { limits: LIMITS, window: TEN_MINUTES })),
    );
    expect(error).toMatchObject({ reason: "media/source_blocked", retryable: false });
    expect(downloads).toHaveLength(1);
  });

  it("goes on with the whole video when the failed section cannot be removed", async () => {
    // Windows refuses to delete a file another process still has open.
    const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
    rmMock.mockImplementation(async (path, options) => {
      if (String(path).endsWith(`${sep}section`)) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      return actual.rm(path, options);
    });
    try {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const { downloads } = fakeTools({ onDownload: failFirst(), durationOf });
      const outcome = await processAcquire({
        ...context({}, {}, { limits: LIMITS, window: TEN_MINUTES }),
        raw: uploaded().raw,
      });
      expect(downloads).toHaveLength(2);
      expect(outcome.result["section"]).toMatchObject({ startMs: 0, endMs: 600_000 });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/section download not removed/),
        expect.anything(),
      );
    } finally {
      rmMock.mockImplementation(actual.rm);
    }
  });
});

describe("processAcquire and the disk", () => {
  const GIB = 1024 ** 3;
  const WINDOWED = { maxBytes: 524_288_000, maxDurationMs: 43_200_000, timeoutMs: 2_400_000 };

  /** A scratch volume with `free` bytes, and the 5 GiB floor. */
  function disk(free: number | (() => number)): DiskGuard {
    return new DiskGuard({
      path: "D:/scratch",
      minFreeBytes: 5 * GIB,
      statfs: async () => ({
        bavail: Math.floor((typeof free === "number" ? free : free()) / 4096),
        bsize: 4096,
      }),
    });
  }

  function tools(onDownload: (child: FakeChild, args: readonly string[], index: number) => Promise<void>): {
    readonly downloads: (readonly string[])[];
  } {
    const downloads: (readonly string[])[] = [];
    spawnMock.mockImplementation(((_binary: string, args: readonly string[]) => {
      const child = new FakeChild();
      setImmediate(() => {
        if (args.includes("--dump-single-json")) {
          child.stdout.write(JSON.stringify(DUMP));
          void child.exit(0);
        } else if (args.includes("-show_streams")) {
          const path = args.at(-1) ?? "";
          const seconds = path.includes(`${sep}section${sep}`) || path.endsWith("window.mp4") ? 600 : 1078;
          child.stdout.write(
            JSON.stringify({ ...PROBED, format: { ...PROBED.format, duration: String(seconds) } }),
          );
          void child.exit(0);
        } else if (args.includes("--version")) {
          child.stdout.write("2026.08.19\n");
          void child.exit(0);
        } else if (args.includes("-avoid_negative_ts")) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- the cut's output, inside the processor's scratch directory
          void writeFile(args.at(-1) ?? "", Buffer.alloc(2_048, 2)).then(async () => child.exit(0));
        } else {
          downloads.push(args);
          void onDownload(child, args, downloads.length - 1);
        }
      });
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn);
    return { downloads };
  }

  it("does not start a download the disk cannot hold, once the metadata says how big it is", async () => {
    // 187 MB of video: the floor plus twice that is 5.74 GB, and 5.5 GB is free.
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { downloads } = tools(landFile);
    const error = await failure(processAcquire({ ...context(), disk: disk(5.5e9) }));
    expect(error).toMatchObject({
      code: "media/disk_full",
      retryable: true,
      reason: "media/source_failed",
    });
    expect(downloads).toHaveLength(0);
  });

  it("does not fall back to the whole video when the disk cannot hold that", async () => {
    // The ten-minute section (104 MB) fits 5.65 GB free; the whole video
    // (187 MB, so 5.74 GB with the floor) does not.
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { downloads } = tools(async (child) => {
      child.stderr.write("ERROR: [download] This format cannot be partially downloaded\n");
      await child.exit(1);
    });
    const error = await failure(
      processAcquire({
        ...context({}, {}, { limits: WINDOWED, window: { maxMs: 600_000, policy: "first" } }),
        disk: disk(5.65e9),
      }),
    );
    expect(error).toMatchObject({ code: "media/acquire_section_failed", retryable: true });
    expect(error.message).toMatch(/not enough free disk/);
    expect(downloads).toHaveLength(1);
  });

  it("hands every download the volume's reserve to stop at", async () => {
    let free = 20 * GIB;
    tools(landFile);
    await processAcquire({
      ...context({}, {}, { limits: WINDOWED, window: { maxMs: 600_000, policy: "first" } }),
      raw: { putFile: vi.fn(async () => 4_096) } as unknown as JobContext["raw"],
      disk: disk(() => free),
    });
    const lowDisk = downloadMock.mock.calls[0]?.[0].lowDisk;
    expect(lowDisk).toBeTypeOf("function");
    await expect(lowDisk?.()).resolves.toBe(false);
    free = 0.5 * GIB;
    await expect(lowDisk?.()).resolves.toBe(true);
  });
});

describe("placeLanded", () => {
  const WINDOW = { maxMs: 600_000, policy: "first" } as const;
  const PLAN = { startMs: 0, endMs: 600_000, sourceDurationMs: 1_078_000, policy: "first" } as const;

  it("keeps a whole source within the window's tolerance whole, and says so", () => {
    expect(
      placeLanded({ window: WINDOW, planned: PLAN, whole: true, landedMs: 612_000, replayedPeakMs: null }),
    ).toEqual({ cut: null, section: null });
  });

  it("re-places the window on the file's own length when the metadata's was wrong", () => {
    // The metadata said 1078 s; the whole file is 2000 s, and the user's peak is at 1500 s.
    expect(
      placeLanded({
        window: { maxMs: 600_000, policy: "most_replayed" },
        planned: PLAN,
        whole: true,
        landedMs: 2_000_000,
        replayedPeakMs: 1_500_000,
      }).cut,
    ).toMatchObject({ startMs: 1_200_000, endMs: 1_800_000, sourceDurationMs: 2_000_000 });
  });

  it("has nothing to place without a window", () => {
    expect(
      placeLanded({ window: undefined, planned: null, whole: true, landedMs: 9e6, replayedPeakMs: null }),
    ).toEqual({ cut: null, section: null });
  });
});

describe("sha256", () => {
  it("gives up on the file as soon as the job is stopped, rather than reading all of it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acquire-hash-"));
    try {
      // Several of the stream's 64 KiB chunks, so there is a loop to leave.
      const bytes = Buffer.alloc(1024 * 1024, 7);
      const path = join(dir, "source.mp4");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in this test's own temp directory
      await writeFile(path, bytes);
      // The control: an unstopped job gets the file's real digest.
      await expect(sha256(path, new AbortController().signal)).resolves.toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      const stop = new AbortController();
      stop.abort("already_completed");
      const error = await failure(sha256(path, stop.signal));
      expect(error).toMatchObject({ code: "media/cancelled", retryable: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
