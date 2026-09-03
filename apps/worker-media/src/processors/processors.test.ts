import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { processProbe } from "./probe.js";
import { processProxy, readEncodeProgress } from "./proxy.js";
import { MediaJobError } from "../errors.js";
import { mediaPrefix } from "../storage-keys.js";

import type { ProbeResult, ProxyResult } from "../probe-result.js";
import type { JobContext } from "../runtime.js";
import type { Settings } from "../settings.js";
import type { ObjectStore } from "../storage.js";

/**
 * The two processors against **real ffmpeg**, with the object store faked.
 *
 * This is the hermetic half of A07's testing: no Redis, no database, no MinIO and
 * no network — but every ffmpeg command line, every parser and every branch of
 * both processors is the shipped one. The fake store's `presignGet` answers a
 * local path, which works because `inputArgs()` only adds the HTTP reconnect
 * options when the source is a URL, so ffmpeg reads a file here and a signed URL
 * in production through exactly the same code.
 *
 * `apps/api/test/media-pipeline.e2e-spec.ts` is the other half: the same
 * processors, spawned as the real worker, against MinIO and Redis and the signed
 * callbacks. Both are needed — this one catches a bad filtergraph in three
 * seconds, and that one catches everything about the wire that a fake cannot.
 */

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const MEDIA = "01JCMED1A00000000000000000";
const PREFIX = mediaPrefix(WS, PROJECT, MEDIA);

function ffmpegAvailable(): boolean {
  return (
    spawnSync("ffmpeg", ["-version"], { stdio: "pipe", shell: true, timeout: 20_000 }).status === 0
  );
}

const CAN_RUN = ffmpegAvailable();
if (!CAN_RUN) console.warn("[processors] skipped — ffmpeg is not on PATH.");

function generate(args: readonly string[]): void {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`fixture failed:\n${result.stderr ?? ""}`);
}

/** Records what was written, and hands ffmpeg a local path in place of a URL. */
interface FakeStore extends ObjectStore {
  readonly written: Map<string, { size: number; contentType: string; body?: Uint8Array }>;
}

function fakeStore(source: string): FakeStore {
  const written = new Map<string, { size: number; contentType: string; body?: Uint8Array }>();
  return {
    bucket: "montaj-derived",
    kind: "r2",
    written,
    presignGet: async () => source,
    putFile: async ({ key, file, contentType }) => {
      const { stat } = await import("node:fs/promises");
      const { size } = await stat(file);
      written.set(key, { size, contentType });
      return size;
    },
    putBody: async ({ key, body, contentType }) => {
      written.set(key, { size: body.byteLength, contentType, body });
      return body.byteLength;
    },
  };
}

function context(
  source: string,
  payload: Record<string, unknown> = {},
): {
  context: JobContext;
  derived: FakeStore;
  progress: number[];
} {
  const derived = fakeStore(source);
  const progress: number[] = [];
  const settings = {
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    tempDir: undefined,
    sourceUrlTtlSeconds: 3_600,
    ffmpegTimeoutMs: 120_000,
    loudnessEnabled: true,
  } as unknown as Settings;

  return {
    derived,
    progress,
    context: {
      settings,
      envelope: {
        jobId: "01JCJ0B0000000000000000000",
        attemptId: "01JCATTEMPT000000000000000",
        workspaceId: WS,
        projectId: PROJECT,
        priority: 3,
        jobKey: `media.probe:${MEDIA}`,
        createdAt: "2026-09-02T00:00:00.000Z",
        payload: { mediaId: MEDIA, key: `${PREFIX}/raw.mp4`, ...payload },
      },
      payload: { mediaId: MEDIA, key: `${PREFIX}/raw.mp4`, ...payload } as never,
      derivedPrefix: PREFIX,
      raw: derived,
      derived,
      callbacks: {} as JobContext["callbacks"],
      report: (value) => progress.push(value),
      signal: new AbortController().signal,
    },
  };
}

let dir = "";
let video = "";
let audio = "";
let hdr = "";
let corrupt = "";
let silent = "";

beforeAll(async () => {
  if (!CAN_RUN) return;
  dir = await mkdtemp(join(tmpdir(), "montaj-processors-"));

  video = join(dir, "clip.mp4");
  generate([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=3",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "34",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    "-movflags",
    "+faststart",
    video,
  ]);

  audio = join(dir, "voice.wav");
  generate([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=44100:duration=2",
    "-c:a",
    "pcm_s16le",
    audio,
  ]);

  hdr = join(dir, "hdr.mp4");
  generate([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=30:duration=1",
    "-vf",
    "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    hdr,
  ]);

  silent = join(dir, "silent.mp4");
  generate([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=15:duration=1",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-an",
    silent,
  ]);

  corrupt = join(dir, "broken.mp4");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  await writeFile(corrupt, randomBytes(32 * 1024));
}, 180_000);

afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!CAN_RUN)("processProbe", () => {
  it("reads the container, the streams and the loudness of a real clip", async () => {
    const { context: ctx, progress } = context(video);
    const outcome = await processProbe(ctx);
    const result = outcome.result as unknown as ProbeResult;

    expect(result.mediaId).toBe(MEDIA);
    expect(result.durationMs).toBeGreaterThan(2_500);
    expect(result.durationMs).toBeLessThan(3_500);
    expect(result.hasVideo).toBe(true);
    expect(result.hasAudio).toBe(true);
    expect(result.video?.codec).toBe("h264");
    expect(result.video?.width).toBe(1280);
    expect(result.video?.height).toBe(720);
    expect(Math.round(result.video?.fps ?? 0)).toBe(30);
    expect(result.video?.hdr).toBe(false);
    expect(result.mime).toBe("video/mp4");
    expect(result.toolVersion).toContain("ffprobe");
    // A 440 Hz tone at full scale is nowhere near silent.
    expect(result.audio?.loudnessLufs).toBeLessThan(0);
    expect(result.audio?.silenceRatio).toBe(0);
    expect(progress[0]).toBe(5);
  }, 120_000);

  it("patches only the columns `media_assets` has, and never the status", async () => {
    // The status is the API's: the completion handler decides between `probing`
    // and `failed` once it has applied the plan's duration cap.
    const { context: ctx } = context(video);
    const outcome = await processProbe(ctx);
    expect(outcome.mediaPatch).toMatchObject({
      hasAudio: true,
      width: 1280,
      height: 720,
      codec: "h264",
      hdr: false,
      mime: "video/mp4",
    });
    expect(outcome.mediaPatch).not.toHaveProperty("status");
    expect(outcome.usage?.mediaSeconds).toBeGreaterThan(2.5);
  }, 120_000);

  it("flags a PQ source as HDR", async () => {
    const { context: ctx } = context(hdr);
    const outcome = await processProbe(ctx);
    expect((outcome.result as unknown as ProbeResult).video?.hdr).toBe(true);
    expect(outcome.mediaPatch).toMatchObject({ hdr: true });
  }, 120_000);

  it("reports an audio-only file with no video at all", async () => {
    const { context: ctx } = context(audio);
    const outcome = await processProbe(ctx);
    const result = outcome.result as unknown as ProbeResult;
    expect(result.hasVideo).toBe(false);
    expect(result.video).toBeNull();
    expect(result.audio?.codec).toBe("pcm_s16le");
    // With no video stream the codec column takes the audio's.
    expect(outcome.mediaPatch).toMatchObject({ codec: "pcm_s16le" });
  }, 120_000);

  it("skips the loudness pass when it is turned off", async () => {
    const { context: ctx } = context(video);
    const off = {
      ...ctx,
      settings: { ...ctx.settings, loudnessEnabled: false } as typeof ctx.settings,
    };
    const outcome = await processProbe(off);
    expect((outcome.result as unknown as ProbeResult).audio?.loudnessLufs).toBeNull();
  }, 120_000);

  it("refuses bytes ffprobe cannot read, terminally", async () => {
    const { context: ctx } = context(corrupt);
    const error = await processProbe(ctx).catch((caught: unknown) => caught as MediaJobError);
    expect(error).toBeInstanceOf(MediaJobError);
    if (!(error instanceof MediaJobError)) throw error;
    expect(error.retryable).toBe(false);
    expect(error.reason).toBe("media/unsupported");
  }, 120_000);
});

describe.skipIf(!CAN_RUN)("processProxy", () => {
  it("writes every CONTRACTS §6 artefact for a video, and nothing else", async () => {
    const { context: ctx, derived } = context(video, {
      durationMs: 3_000,
      hasVideo: true,
      hasAudio: true,
      width: 1280,
      height: 720,
      hdr: false,
    });
    const outcome = await processProxy(ctx);
    const result = outcome.result as unknown as ProxyResult;

    expect(result.proxyKey).toBe(`${PREFIX}/proxy540.mp4`);
    expect(result.audio16kKey).toBe(`${PREFIX}/audio16k.wav`);
    expect(result.audio48kKey).toBe(`${PREFIX}/audio48k.wav`);
    expect(result.waveformKey).toBe(`${PREFIX}/waveform.json`);
    expect(result.thumbKeys.length).toBeGreaterThanOrEqual(9);
    expect(result.bytesWritten).toBeGreaterThan(0);

    // Nothing outside the four artefacts and the thumbnails: CONTRACTS §6 has no
    // poster key, so there is no `poster.jpg` here.
    for (const key of derived.written.keys()) {
      expect(key.startsWith(`${PREFIX}/`), key).toBe(true);
      expect(
        /\/(proxy540\.mp4|audio16k\.wav|audio48k\.wav|waveform\.json|thumb-\d+\.jpg)$/.test(key),
        key,
      ).toBe(true);
    }
    expect([...derived.written.keys()].some((key) => key.includes("poster"))).toBe(false);

    // The proxy is 540p on its short side, and the WAVs are the right rates.
    expect(derived.written.get(`${PREFIX}/proxy540.mp4`)?.contentType).toBe("video/mp4");
    const asr = derived.written.get(`${PREFIX}/audio16k.wav`)?.size ?? 0;
    const master = derived.written.get(`${PREFIX}/audio48k.wav`)?.size ?? 0;
    expect(asr).toBeGreaterThan(16_000 * 2 * 2);
    expect(master).toBeGreaterThan(asr * 2.5);

    // The row is only `ready` once every key above exists.
    expect(outcome.mediaPatch).toMatchObject({
      status: "ready",
      proxyKey: `${PREFIX}/proxy540.mp4`,
    });
    expect(outcome.usage?.egressBytes).toBe(result.bytesWritten);
  }, 240_000);

  it("builds a waveform whose peaks match the tone that was encoded", async () => {
    const { context: ctx, derived } = context(video, {
      durationMs: 3_000,
      hasVideo: true,
      hasAudio: true,
      width: 1280,
      height: 720,
    });
    await processProxy(ctx);
    const body = derived.written.get(`${PREFIX}/waveform.json`)?.body;
    expect(body).toBeDefined();
    const waveform = JSON.parse(Buffer.from(body ?? new Uint8Array()).toString("utf8")) as {
      peakRate: number;
      peaks: number[];
      rms: { rate: number; values: number[] };
    };
    expect(waveform.peakRate).toBe(100);
    expect(waveform.peaks.length).toBeGreaterThan(250);
    expect(waveform.rms.rate).toBe(10);
    // A steady sine: loud everywhere, and never above full scale.
    expect(Math.max(...waveform.peaks)).toBeGreaterThan(0.5);
    expect(Math.max(...waveform.peaks)).toBeLessThanOrEqual(1);
  }, 240_000);

  it("skips the video half entirely for an audio-only input", async () => {
    const { context: ctx, derived } = context(audio, {
      durationMs: 2_000,
      hasVideo: false,
      hasAudio: true,
    });
    const outcome = await processProxy(ctx);
    const result = outcome.result as unknown as ProxyResult;

    expect(result.proxyKey).toBeNull();
    expect(result.thumbKeys).toEqual([]);
    expect(result.audio16kKey).not.toBeNull();
    expect(derived.written.has(`${PREFIX}/proxy540.mp4`)).toBe(false);
    expect(outcome.mediaPatch).toMatchObject({ status: "ready", thumbKeys: [] });
    expect(outcome.mediaPatch).not.toHaveProperty("proxyKey");
  }, 240_000);

  it("skips the audio half entirely for a silent video", async () => {
    const { context: ctx, derived } = context(silent, {
      durationMs: 1_000,
      hasVideo: true,
      hasAudio: false,
      width: 320,
      height: 240,
    });
    const outcome = await processProxy(ctx);
    expect(derived.written.has(`${PREFIX}/audio16k.wav`)).toBe(false);
    expect(derived.written.has(`${PREFIX}/waveform.json`)).toBe(false);
    expect(derived.written.has(`${PREFIX}/proxy540.mp4`)).toBe(true);
    expect((outcome.result as unknown as ProxyResult).audio16kKey).toBeNull();
  }, 240_000);

  it("tone-maps an HDR source rather than refusing it", async () => {
    const { context: ctx, derived } = context(hdr, {
      durationMs: 1_000,
      hasVideo: true,
      hasAudio: false,
      width: 640,
      height: 360,
      hdr: true,
    });
    await processProxy(ctx);
    expect(derived.written.get(`${PREFIX}/proxy540.mp4`)?.size ?? 0).toBeGreaterThan(500);
  }, 240_000);

  it("probes for itself when the payload carries no measurements", async () => {
    // A job replayed from the dead-letter queue months later may have been written
    // by a worker version that no longer exists.
    const { context: ctx, derived } = context(silent);
    const outcome = await processProxy(ctx);
    expect((outcome.result as unknown as ProxyResult).durationMs).toBeGreaterThan(500);
    expect(derived.written.has(`${PREFIX}/proxy540.mp4`)).toBe(true);
  }, 240_000);
});

describe("readEncodeProgress", () => {
  it("turns ffmpeg's out_time_us into a fraction of the duration", () => {
    expect(readEncodeProgress("out_time_us=5000000\nspeed=2x\n", 10_000)).toBeCloseTo(0.5, 3);
    expect(readEncodeProgress("out_time_us=0\n", 10_000)).toBe(0);
  });

  it("clamps past the end, because the last packet can overshoot", () => {
    expect(readEncodeProgress("out_time_us=99000000\n", 10_000)).toBe(1);
  });

  it("answers null for a chunk with no progress in it", () => {
    // `N/A` appears while the first frame is still being decoded.
    expect(readEncodeProgress("out_time_us=N/A\n", 10_000)).toBeNull();
    expect(readEncodeProgress("frame=12\n", 10_000)).toBeNull();
    expect(readEncodeProgress("out_time_us=1000\n", 0)).toBeNull();
  });
});
