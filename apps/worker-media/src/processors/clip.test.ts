import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { audiogramLayout } from "./audiogram.js";
import {
  MAX_CLIP_HEIGHT,
  STACK_FACE_ROW,
  clipFilter,
  clipFrame,
  dynamicCropExpressions,
  fitFilter,
  fitFrame,
  interpolateTrajectoryAt,
  remotionVideoTransform,
  splitScreenFilter,
  splitScreenFrame,
  stackedFilter,
  stackedFrame,
  toSplitScreenConfig,
  type DynamicReframeTrajectory,
  type SplitScreenConfig,
} from "./clip-frame.js";
import { classifyReadFailure, cutCameOutShort, processClip } from "./clip.js";
import { MediaJobError } from "../errors.js";

import type { ClipPayload } from "./clip.js";
import type { JobContext } from "../runtime.js";
import type { Settings } from "../settings.js";
import type { ObjectStore } from "../storage.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const RUN_ID = "01JCRUN0000000000000000000";
const CANDIDATE_ID = "01JCCANDIDATE000000000000";
const CLIP_ID = "01JCCLIP00000000000000000";
const URL_SOURCE = "http://minio:9000/montaj-raw/ws/source/raw.mp4?X-Amz-Signature=secret";

function ffmpegAvailable(): boolean {
  return (
    spawnSync("ffmpeg", ["-version"], { stdio: "pipe", shell: true, timeout: 20_000 }).status === 0
  );
}

const CAN_RUN = ffmpegAvailable();
if (!CAN_RUN) console.warn("[clip.test] skipped — ffmpeg is not on PATH.");

function generate(args: readonly string[]): void {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`fixture failed:\n${result.stderr ?? ""}`);
}

interface FakeStore extends ObjectStore {
  readonly written: Map<string, { size: number; contentType: string; body?: Uint8Array }>;
}

function fakeStore(sourceResolver: (key: string) => Promise<string> | string): FakeStore {
  const written = new Map<string, { size: number; contentType: string; body?: Uint8Array }>();
  return {
    bucket: "montaj-derived",
    kind: "r2",
    written,
    presignGet: async (key: string) => sourceResolver(key),
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

/** A store that also keeps a copy of the uploaded mezzanine at `kept`. */
function keepingStore(sourcePath: string, kept: string): FakeStore {
  const store = fakeStore(() => sourcePath);
  return {
    ...store,
    putFile: async (input) => {
      await copyFile(input.file, kept);
      return store.putFile(input);
    },
  };
}

function dimensions(file: string): { width: number; height: number } {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      file,
    ],
    { stdio: "pipe", encoding: "utf8", timeout: 60_000 },
  );
  const [width, height] = probe.stdout.trim().split(",").map(Number);
  return { width: width ?? 0, height: height ?? 0 };
}

function hasVideoStream(file: string): boolean {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      file,
    ],
    { stdio: "pipe", encoding: "utf8", timeout: 60_000 },
  );
  return probe.stdout.trim() !== "";
}

/** One frame at one second, as 8-bit luma. */
function lumaAt1s(file: string): Buffer {
  const frame = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-loglevel",
      "error",
      "-ss",
      "1",
      "-i",
      file,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { stdio: "pipe", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  expect(frame.status).toBe(0);
  return frame.stdout as Buffer;
}

function countAbove(luma: Buffer, threshold: number): number {
  let count = 0;
  for (const value of luma) if (value > threshold) count += 1;
  return count;
}

/** How many pixels of rows `[fromRow, toRow)` of a `width`-wide luma frame are in `[low, high]`. */
function countInRows(
  luma: Buffer,
  width: number,
  fromRow: number,
  toRow: number,
  low: number,
  high: number,
): number {
  let count = 0;
  for (const value of luma.subarray(fromRow * width, toRow * width)) {
    if (value >= low && value <= high) count += 1;
  }
  return count;
}

async function failureOf(context: JobContext): Promise<MediaJobError> {
  const error = await processClip(context).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MediaJobError);
  if (!(error instanceof MediaJobError)) throw error;
  return error;
}

/**
 * A context for one `processClip` run.
 *
 * `onReport` sees every progress report as it is made, with the controller
 * behind `context.signal`: a test that aborts at a given stage does it there.
 */
function buildContext(
  sourcePath: string,
  payloadOverrides: Partial<ClipPayload> = {},
  storeOverride?: FakeStore,
  settingsOverrides: Partial<Settings> = {},
  onReport?: (value: number, abort: AbortController) => void,
): {
  context: JobContext;
  derived: FakeStore;
  progress: number[];
} {
  const derived = storeOverride ?? fakeStore(() => sourcePath);
  const progress: number[] = [];
  const abort = new AbortController();
  const settings = {
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    tempDir: undefined,
    sourceUrlTtlSeconds: 3_600,
    ffmpegTimeoutMs: 120_000,
    loudnessEnabled: true,
    ...settingsOverrides,
  } as unknown as Settings;

  const payload: ClipPayload = {
    runId: RUN_ID,
    candidateId: CANDIDATE_ID,
    clipId: CLIP_ID,
    source: { bucket: "s3", key: "ws/source/raw.mp4" },
    sourceDurationMs: 5_000,
    startMs: 500,
    endMs: 2_500,
    handleMs: 200,
    destination: { bucket: "s3", key: `ws/${WS}/clips/${CLIP_ID}/master.mp4` },
    // What the API sends: the clip project's 1080 x 1920 canvas.
    profile: { container: "mp4", videoCodec: "h264", audioCodec: "aac", maxHeight: 1_920 },
    ...payloadOverrides,
  };

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
        jobKey: `media.clip:${CLIP_ID}`,
        createdAt: "2026-09-02T00:00:00.000Z",
        payload: payload as never,
      },
      payload: payload as never,
      derivedPrefix: `ws/${WS}`,
      raw: derived,
      derived,
      callbacks: {} as JobContext["callbacks"],
      report: (value) => {
        progress.push(value);
        onReport?.(value, abort);
      },
      signal: abort.signal,
    },
  };
}

let dir = "";
let video = "";
let flat = "";
let corrupt = "";
let boxed = "";
let truncated = "";
let audioOnly = "";
let resized = "";
let twoBoxed = "";

/**
 * A stand-in for the object store's signed URLs, serving `video` with range
 * support like MinIO does:
 *
 * - `/ok/…`: plain.
 * - `/drop/…`: every response that starts at byte 0 is cut off a quarter of the
 *   way in, as a flaky connection would, so each tool's first read fails and
 *   only a reconnect (a new range request from where it stopped) gets the rest.
 * - `/404/…`, `/503/…`: those statuses, as S3 answers them.
 * - `/once-404/…`, `/once-503/…`: the first request for a path is served like
 *   `/ok/`, and every later one gets that status. The probe of a faststart file
 *   is one request from byte 0, so the probe reads clean and the CUT is what
 *   the store refuses.
 * - `/stall/…`: the same, except that every later request is never answered.
 */
let server: Server | null = null;
let origin = "";
const requestsByPath = new Map<string, number>();

async function startSourceServer(file: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture read from the temporary directory
  const body = await readFile(file);
  server = createServer((request, response) => {
    const url = request.url ?? "";
    const path = url.split("?")[0] ?? url;
    const seen = (requestsByPath.get(path) ?? 0) + 1;
    requestsByPath.set(path, seen);
    if (seen > 1 && url.startsWith("/stall/")) return;
    if (url.startsWith("/404/") || (seen > 1 && url.startsWith("/once-404/"))) {
      response.writeHead(404).end("NoSuchKey");
      return;
    }
    if (url.startsWith("/503/") || (seen > 1 && url.startsWith("/once-503/"))) {
      response.writeHead(503).end("SlowDown");
      return;
    }
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
    const start = range === null ? 0 : Number(range[1]);
    const end = range?.[2] ? Number(range[2]) : body.length - 1;
    response.writeHead(range === null ? 200 : 206, {
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${String(start)}-${String(end)}/${String(body.length)}`,
      "Content-Type": "video/mp4",
    });
    const slice = body.subarray(start, end + 1);
    if (url.startsWith("/drop/") && start === 0) {
      response.write(slice.subarray(0, Math.floor(body.length / 4)), () => {
        setTimeout(() => request.socket.destroy(), 50);
      });
      return;
    }
    response.end(slice);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

beforeAll(async () => {
  if (!CAN_RUN) return;
  dir = await mkdtemp(join(tmpdir(), "montaj-clip-test-"));

  video = join(dir, "source.mp4");
  generate([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
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

  // One flat mid-blue field: any burned-in caption shows up as near-white pixels.
  flat = join(dir, "flat.mp4");
  generate([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x3050a0:size=1280x720:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    flat,
  ]);

  corrupt = join(dir, "corrupt.mp4");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write in temporary directory
  await writeFile(corrupt, randomBytes(32 * 1024));

  // A dark field with a white "subject" off to the right: x 992-1088 of 1280,
  // centred at 0.8125 of the width. The centre 9:16 window (x 436-842) misses it.
  boxed = join(dir, "boxed.mp4");
  generate([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x202020:size=1280x720:rate=30:duration=4,drawbox=x=992:y=300:w=96:h=120:color=white@1:t=fill",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    boxed,
  ]);

  // Ten seconds with its index up front, cut off half way: the probe still reads
  // "10 s", and ffmpeg exits 0 after writing what the bytes held.
  const long = join(dir, "long.mp4");
  generate([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=30:duration=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=10",
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
    long,
  ]);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture read from the temporary directory
  const whole = await readFile(long);
  truncated = join(dir, "truncated.mp4");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write in temporary directory
  await writeFile(truncated, whole.subarray(0, Math.floor(whole.length / 2)));

  audioOnly = join(dir, "audio-only.m4a");
  generate([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
    "-c:a",
    "aac",
    audioOnly,
  ]);

  // A picture that drops from 640 x 360 to 320 x 180 two seconds in, as an
  // adaptive or WebRTC recording does. The probe reads the first size.
  const segments: Buffer[] = [];
  for (const [size, offset] of [
    ["640x360", "0"],
    ["320x180", "2"],
  ] as const) {
    const segment = join(dir, `segment-${size}.ts`);
    generate([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${size}:rate=30:duration=2`,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-output_ts_offset",
      offset,
      "-f",
      "mpegts",
      segment,
    ]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture read from the temporary directory
    segments.push(await readFile(segment));
  }
  resized = join(dir, "resized.ts");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write in temporary directory
  await writeFile(resized, Buffer.concat(segments));

  // Two "people" at a table, as one wide camera sees a podcast: a white box on
  // the left (x 112-176, y 100-180 of 640 x 360) and a mid-grey one on the right
  // (x 464-528, y 110-190). Different brightness, so each half of a stacked cut
  // can be told apart.
  twoBoxed = join(dir, "two-boxed.mp4");
  generate([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x202020:size=640x360:rate=30:duration=3,drawbox=x=112:y=100:w=64:h=80:color=white@1:t=fill,drawbox=x=464:y=110:w=64:h=80:color=0x808080@1:t=fill",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=3",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    twoBoxed,
  ]);

  await startSourceServer(video);
}, 180_000);

afterAll(async () => {
  if (server !== null) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

describe("clipFrame — every format a clip is cut in (2026-09-29)", () => {
  const uhd = { width: 3840, height: 2160 };

  it("cuts 4:5 and 1:1 windows across a landscape source, centred on the face", () => {
    const portrait = clipFrame(uhd, { aspect: "4:5", maxHeight: 1350, centerX: 0.3 });
    expect(portrait?.crop).toMatchObject({ width: 1728, height: 2160, y: 0 });
    expect(portrait?.output).toEqual({ width: 1080, height: 1350 });
    // Centred on 30 % of the width: 1152 - 864 = 288.
    expect(portrait?.crop.x).toBe(288);

    const square = clipFrame(uhd, { aspect: "1:1", maxHeight: 1080 });
    expect(square?.crop).toMatchObject({ width: 2160, height: 2160, x: 840 });
    expect(square?.output).toEqual({ width: 1080, height: 1080 });
  });

  it("keeps a 16:9 source whole for 16:9, scaled to 1080p", () => {
    const wide = clipFrame(uhd, { aspect: "16:9", maxHeight: 1080 });
    expect(wide?.crop).toEqual({ width: 3840, height: 2160, x: 0, y: 0 });
    expect(wide?.output).toEqual({ width: 1920, height: 1080 });
  });

  it("cuts a band out of a vertical source for 16:9, around the face's height", () => {
    const band = clipFrame({ width: 1080, height: 1920 }, { aspect: "16:9", centerY: 0.3 });
    expect(band?.crop).toMatchObject({ width: 1080, height: 608, x: 0 });
    // Centred on 30 % of the height: 576 - 304 = 272.
    expect(band?.crop.y).toBe(272);
    // Middle when no face says otherwise.
    expect(clipFrame({ width: 1080, height: 1920 }, { aspect: "16:9" })?.crop.y).toBe(656);
  });

  it("still cuts 9:16 when no shape is named", () => {
    expect(clipFrame(uhd)?.crop).toMatchObject({ width: 1216, height: 2160 });
  });
});

describe("clipFrame", () => {
  it("cuts a 4K landscape source to a 1080 x 1920 mezzanine from its full height", () => {
    expect(clipFrame({ width: 3840, height: 2160 }, { maxHeight: 1920 })).toEqual({
      source: { width: 3840, height: 2160 },
      crop: { width: 1216, height: 2160, x: 1312, y: 0 },
      output: { width: 1080, height: 1920 },
    });
  });

  it("never scales a crop up: 1080p makes a 608 x 1080 mezzanine", () => {
    expect(clipFrame({ width: 1920, height: 1080 }, { maxHeight: 1920 })?.output).toEqual({
      width: 608,
      height: 1080,
    });
  });

  it("scales down to maxHeight when the crop is taller", () => {
    expect(clipFrame({ width: 1920, height: 1080 }, { maxHeight: 720 })?.output).toEqual({
      width: 406,
      height: 720,
    });
  });

  it("caps maxHeight at the 1920 canvas", () => {
    expect(clipFrame({ width: 3840, height: 2160 }, { maxHeight: 2160 })?.output.height).toBe(
      MAX_CLIP_HEIGHT,
    );
    expect(clipFrame({ width: 3840, height: 2160 })?.output.height).toBe(MAX_CLIP_HEIGHT);
  });

  it("centres the window on centerX", () => {
    const frame = clipFrame({ width: 1920, height: 1080 }, { centerX: 0.8 });
    // 0.8 x 1920 = 1536; the 608-wide window is 1232-1840.
    expect(frame?.crop).toEqual({ width: 608, height: 1080, x: 1232, y: 0 });
  });

  it("keeps the window inside the frame at either edge", () => {
    expect(clipFrame({ width: 1920, height: 1080 }, { centerX: 0.98 })?.crop.x).toBe(1312);
    expect(clipFrame({ width: 1920, height: 1080 }, { centerX: 1 })?.crop.x).toBe(1312);
    expect(clipFrame({ width: 1920, height: 1080 }, { centerX: 0.02 })?.crop.x).toBe(0);
    expect(clipFrame({ width: 1920, height: 1080 }, { centerX: -4 })?.crop.x).toBe(0);
  });

  it("uses the frame centre when centerX is absent or not a number", () => {
    expect(clipFrame({ width: 1920, height: 1080 })?.crop.x).toBe(656);
    expect(clipFrame({ width: 1920, height: 1080 }, { centerX: Number.NaN })?.crop.x).toBe(656);
  });

  it("does not cut a 9:16 source sideways, wherever the face is", () => {
    expect(clipFrame({ width: 1080, height: 1920 }, { centerX: 0.1, maxHeight: 1920 })).toEqual({
      source: { width: 1080, height: 1920 },
      crop: { width: 1080, height: 1920, x: 0, y: 0 },
      output: { width: 1080, height: 1920 },
    });
    expect(clipFrame({ width: 2160, height: 3840 }, { centerX: 0.9 })?.output).toEqual({
      width: 1080,
      height: 1920,
    });
  });

  it("trims a source narrower than 9:16 top and bottom equally", () => {
    expect(clipFrame({ width: 720, height: 1600 }, { centerX: 0.9 })?.crop).toEqual({
      width: 720,
      height: 1280,
      x: 0,
      y: 160,
    });
  });

  it("keeps every number even for odd sources", () => {
    const frame = clipFrame({ width: 1279, height: 719 }, { centerX: 0.37 });
    expect(frame).not.toBeNull();
    for (const value of [
      frame?.crop.width,
      frame?.crop.height,
      frame?.crop.x,
      frame?.crop.y,
      frame?.output.width,
      frame?.output.height,
    ]) {
      expect((value ?? 1) % 2).toBe(0);
    }
    expect((frame?.crop.x ?? 0) + (frame?.crop.width ?? 0)).toBeLessThanOrEqual(1279);
  });

  it("has nothing to frame without a picture size", () => {
    expect(clipFrame({ width: 0, height: 0 })).toBeNull();
    expect(clipFrame({ width: Number.NaN, height: 1080 })).toBeNull();
  });

  it("builds a crop without a no-op output scale, and a scale when it shrinks", () => {
    const small = clipFrame({ width: 1920, height: 1080 }, { maxHeight: 1920 });
    const large = clipFrame({ width: 3840, height: 2160 }, { maxHeight: 1920 });
    if (small === null || large === null) throw new Error("expected frames");
    expect(clipFilter(small)).toBe("scale=1920:1080,crop=608:1080:656:0,setsar=1,format=yuv420p");
    expect(clipFilter(large)).toBe(
      "scale=3840:2160,crop=1216:2160:1312:0,scale=1080:1920:flags=bicubic,setsar=1,format=yuv420p",
    );
  });

  // A fixed crop wider than a picture that shrank mid-stream failed the cut
  // with "Error reinitializing filters!"; scaled back first, it always fits.
  it("scales every frame back to the probed size before the crop", () => {
    const frame = clipFrame({ width: 1279, height: 719 }, { centerX: 0.37 });
    if (frame === null) throw new Error("expected a frame");
    expect(clipFilter(frame).split(",")[0]).toBe("scale=1279:719");
    expect(clipFilter(frame).split(",")[1]).toMatch(/^crop=/);
  });
});

describe("stackedFrame — two people, one above the other (2026-10-01)", () => {
  const uhd = { width: 3840, height: 2160 };
  const fullHd = { width: 1920, height: 1080 };
  const podcast = [
    { centerX: 0.3, centerY: 0.4, size: 0.12 },
    { centerX: 0.72, centerY: 0.42, size: 0.11 },
  ];

  /** Where a person's face centre lands inside their window, as fractions of it. */
  function faceIn(
    crop: { width: number; height: number; x: number; y: number },
    person: { centerX: number; centerY: number },
    source: { width: number; height: number },
  ): { x: number; y: number } {
    return {
      x: (person.centerX * source.width - crop.x) / crop.width,
      y: (person.centerY * source.height - crop.y) / crop.height,
    };
  }

  it("cuts a 4K podcast into two 1080 x 960 halves, each person on the upper third", () => {
    const frame = stackedFrame(uhd, { people: podcast, maxHeight: 1920 });
    if (frame === null) throw new Error("expected a stack");
    expect(frame.half).toEqual({ width: 1080, height: 960 });
    expect(frame.output).toEqual({ width: 1080, height: 1920 });
    for (const [index, crop] of frame.crops.entries()) {
      const person = podcast.at(index);
      if (person === undefined) throw new Error("two people");
      const at = faceIn(crop, person, uhd);
      expect(at.x).toBeCloseTo(0.5, 2);
      expect(at.y).toBeCloseTo(STACK_FACE_ROW, 2);
      // Wide enough for a head and shoulders, never scaled up to the half.
      expect(crop.height).toBeGreaterThanOrEqual(frame.half.height);
      expect(crop.width).toBeGreaterThanOrEqual(frame.half.width);
    }
  });

  it("keeps each window on its person's side, so no half shows the other face", () => {
    const frame = stackedFrame(fullHd, {
      people: [
        { centerX: 0.4, centerY: 0.4, size: 0.15 },
        { centerX: 0.6, centerY: 0.4, size: 0.15 },
      ],
    });
    if (frame === null) throw new Error("expected a stack");
    const [upper, lower] = frame.crops;
    expect(upper.x + upper.width).toBeLessThanOrEqual(960);
    expect(lower.x).toBeGreaterThanOrEqual(960);
  });

  it("never scales a 1080p source up, and never zooms past half its height", () => {
    const frame = stackedFrame(fullHd, {
      people: [
        { centerX: 0.28, centerY: 0.45, size: 0.12 },
        { centerX: 0.74, centerY: 0.45, size: 0.05 },
      ],
      maxHeight: 1920,
    });
    if (frame === null) throw new Error("expected a stack");
    // The small face is not zoomed to fill its half: half the source's height.
    expect(frame.crops[1].height).toBe(540);
    // Both halves are the smaller window's size; the other is scaled down to it.
    expect(frame.half.height).toBe(Math.min(frame.crops[0].height, frame.crops[1].height));
    expect(frame.output.height).toBe(frame.half.height * 2);
    expect(frame.output.width / frame.output.height).toBeCloseTo(9 / 16, 2);
  });

  it("cuts 4:5 halves of 8:5, capped at half of 1350", () => {
    const frame = stackedFrame(uhd, { people: podcast, aspect: "4:5", maxHeight: 1350 });
    if (frame === null) throw new Error("expected a stack");
    expect(frame.half).toEqual({ width: 1078, height: 674 });
    expect(frame.output).toEqual({ width: 1078, height: 1348 });
    for (const crop of frame.crops) expect(crop.width / crop.height).toBeCloseTo(8 / 5, 2);
  });

  it("clamps a window at the frame's edges rather than leave the picture", () => {
    const frame = stackedFrame(fullHd, {
      people: [
        { centerX: 0.03, centerY: 0.04, size: 0.1 },
        { centerX: 0.6, centerY: 0.97, size: 0.1 },
      ],
    });
    if (frame === null) throw new Error("expected a stack");
    expect(frame.crops[0].x).toBe(0);
    expect(frame.crops[0].y).toBe(0);
    const lower = frame.crops[1];
    expect(lower.y + lower.height).toBeLessThanOrEqual(1080);
    expect(lower.x + lower.width).toBeLessThanOrEqual(1920);
  });

  it("puts the first person on top, wherever they sit", () => {
    const frame = stackedFrame(fullHd, { people: [...podcast].reverse() });
    if (frame === null) throw new Error("expected a stack");
    expect(frame.crops[0].x).toBeGreaterThan(frame.crops[1].x);
  });

  it("keeps every number even", () => {
    const frame = stackedFrame(
      { width: 1279, height: 719 },
      {
        people: [
          { centerX: 0.31, centerY: 0.37, size: 0.13 },
          { centerX: 0.77, centerY: 0.41, size: 0.17 },
        ],
      },
    );
    if (frame === null) throw new Error("expected a stack");
    for (const value of [
      ...frame.crops.flatMap((crop) => [crop.width, crop.height, crop.x, crop.y]),
      frame.half.width,
      frame.half.height,
      frame.output.width,
      frame.output.height,
    ]) {
      expect(value % 2).toBe(0);
    }
  });

  it("does not stack what it cannot: a tall or square source, a square or wide shape, one person, one place", () => {
    const two = { people: podcast };
    expect(stackedFrame({ width: 1080, height: 1920 }, two)).toBeNull();
    expect(stackedFrame({ width: 1080, height: 1080 }, two)).toBeNull();
    expect(stackedFrame(uhd, { ...two, aspect: "1:1" })).toBeNull();
    expect(stackedFrame(uhd, { ...two, aspect: "16:9" })).toBeNull();
    expect(stackedFrame(uhd, { people: podcast.slice(0, 1) })).toBeNull();
    expect(stackedFrame(uhd, { people: [...podcast, ...podcast] })).toBeNull();
    expect(
      stackedFrame(uhd, {
        people: [
          { centerX: 0.5, centerY: 0.4, size: 0.1 },
          { centerX: 0.52, centerY: 0.4, size: 0.1 },
        ],
      }),
    ).toBeNull();
    expect(
      stackedFrame(uhd, {
        people: [{ centerX: Number.NaN, centerY: 0.4, size: 0.1 }, ...podcast.slice(1)],
      }),
    ).toBeNull();
    expect(stackedFrame({ width: 0, height: 0 }, two)).toBeNull();
  });

  it("builds a graph that scales to the probed size first, then splits, cuts and stacks", () => {
    const frame = stackedFrame(fullHd, {
      people: [
        { centerX: 0.28, centerY: 0.45, size: 0.12 },
        { centerX: 0.74, centerY: 0.45, size: 0.05 },
      ],
    });
    if (frame === null) throw new Error("expected a stack");
    const [upper, lower] = frame.crops;
    expect(stackedFilter(frame)).toBe(
      [
        "scale=1920:1080,split=2[top][bottom]",
        `[top]crop=${String(upper.width)}:${String(upper.height)}:${String(upper.x)}:${String(upper.y)},scale=${String(frame.half.width)}:${String(frame.half.height)}:flags=bicubic,setsar=1[upper]`,
        `[bottom]crop=${String(lower.width)}:${String(lower.height)}:${String(lower.x)}:${String(lower.y)},setsar=1[lower]`,
        "[upper][lower]vstack=inputs=2,setsar=1,format=yuv420p",
      ].join(";"),
    );
  });
});

describe("fitFrame, fitFilter", () => {
  it("fits a 16:9 widescreen source into a 9:16 canvas with blurred background", () => {
    const fullHd = { width: 1920, height: 1080 };
    const frame = fitFrame(fullHd, { aspect: "9:16", maxHeight: 1080 });
    expect(frame).not.toBeNull();
    if (frame === null) return;
    expect(frame.output).toEqual({ width: 608, height: 1080 });
    expect(frame.fg.width).toBe(608);
    expect(frame.fg.height).toBe(342);
    expect(frame.fg.x).toBe(0);
    expect(frame.fg.y).toBe(368);

    const filter = fitFilter(frame);
    expect(filter).toContain("boxblur=20:5");
    expect(filter).toContain("overlay=0:368");
  });

  it("returns null for non-landscape or unsupported aspects", () => {
    expect(fitFrame({ width: 1080, height: 1920 }, { aspect: "9:16" })).toBeNull();
    expect(fitFrame({ width: 1920, height: 1080 }, { aspect: "16:9" as any })).toBeNull();
  });
});

describe("dynamicCropExpressions, interpolateTrajectoryAt, remotionVideoTransform (Pillar 3 §01)", () => {
  const trajectory: DynamicReframeTrajectory = {
    interpolation: "SPRING_DAMPED",
    keyframes: [
      { timeSec: 0, centerX: 0.25, centerY: 0.5, zoom: 1 },
      { timeSec: 2, centerX: 0.75, centerY: 0.5, zoom: 1.1 },
    ],
  };

  it("builds a bounded even-aligned FFmpeg crop expression when keyframes pan across the frame", () => {
    const frame = clipFrame({ width: 1920, height: 1080 }, { centerX: 0.25 });
    if (frame === null) throw new Error("expected a frame");
    const expr = dynamicCropExpressions(frame, trajectory, 0.2);
    expect(expr.isDynamic).toBe(true);
    expect(expr.xExpr).toContain("trunc(clip(");
    expect(expr.xExpr).toContain("/2)*2");

    const filter = clipFilter(frame, trajectory, 0.2);
    expect(filter).toContain(`crop=608:1080:x='${expr.xExpr}':y='${expr.yExpr}'`);
  });

  it("falls back to static crop when trajectory keyframes do not move", () => {
    const frame = clipFrame({ width: 1920, height: 1080 }, { centerX: 0.5 });
    if (frame === null) throw new Error("expected a frame");
    const staticTraj: DynamicReframeTrajectory = {
      interpolation: "SPRING_DAMPED",
      keyframes: [
        { timeSec: 0, centerX: 0.5, centerY: 0.5, zoom: 1 },
        { timeSec: 3, centerX: 0.5, centerY: 0.5, zoom: 1 },
      ],
    };
    expect(clipFilter(frame, staticTraj)).toBe(
      "scale=1920:1080,crop=608:1080:656:0,setsar=1,format=yuv420p",
    );
  });

  it("computes Remotion CSS transform and interpolates keyframes smoothly", () => {
    const start = remotionVideoTransform(trajectory, 0);
    expect(start.keyframe.centerX).toBeCloseTo(0.25, 3);
    expect(start.style.transform).toContain("scale(1.0000)");
    expect(start.style.transform).toContain("translate3d(25.000%, 0.000%, 0)");

    const mid = interpolateTrajectoryAt(trajectory, 1);
    expect(mid.centerX).toBeGreaterThan(0.25);
    expect(mid.centerX).toBeLessThan(0.75);

    const end = remotionVideoTransform(trajectory, 2);
    expect(end.keyframe.centerX).toBeCloseTo(0.75, 3);
    expect(end.style.transform).toContain("scale(1.1000)");
    expect(end.style.transform).toContain("translate3d(-25.000%, 0.000%, 0)");
  });
});

describe("cutCameOutShort", () => {
  it.each([
    // readProbe's "unknown" is never a length: this used to pass a short clip
    // through with the asked-for length standing in for a measurement.
    [0, 500, true],
    [0, 8_000, true],
    [4_000, 8_000, true],
    [7_950, 8_000, false],
    // A second's floor for frame and AAC boundaries on a short clip...
    [900, 1_200, false],
    // ...and 5 % of a long one.
    [56_000, 60_000, true],
    [57_500, 60_000, false],
  ])("measured %d ms of an expected %d ms is short: %s", (measuredMs, expectedMs, short) => {
    expect(cutCameOutShort(measuredMs, expectedMs)).toBe(short);
  });
});

describe("classifyReadFailure", () => {
  // Lines as this machine's ffmpeg 9 prints them, plus Linux's wording where it
  // differs; the signed query strings are already redacted by then. The second
  // column is the source the tool was reading.
  it.each([
    ["[in#0 @ 0] Error opening input: Server returned 404 Not Found", URL_SOURCE, "missing"],
    [
      "[in#0 @ 0] Error opening input: No such file or directory\nError opening input file /src/raw.mp4.\nError opening input files: No such file or directory",
      "/src/raw.mp4",
      "missing",
    ],
    // ffprobe names the path it could not open.
    ["/src/raw.mp4: No such file or directory", "/src/raw.mp4", "missing"],
    // The cut's OUTPUT could not be opened (its workspace went away): a local
    // fault a retry clears. This used to say the source was gone, for good.
    [
      "[out#0/mp4 @ 0] Error opening output /tmp/montaj-clip-x/mezzanine.mp4: No such file or directory\nError opening output file /tmp/montaj-clip-x/mezzanine.mp4.\nError opening output files: No such file or directory",
      URL_SOURCE,
      "transient",
    ],
    // ffmpeg before 6 prints the output path the same way ffprobe prints an input.
    ["/tmp/montaj-clip-x/mezzanine.mp4: No such file or directory", "/src/raw.mp4", "transient"],
    ["Error opening input files: Server returned 5XX Server Error reply", URL_SOURCE, "transient"],
    [
      "http://x/y?<redacted>: Server returned 403 Forbidden (access denied)",
      URL_SOURCE,
      "transient",
    ],
    [
      "[tcp @ 0] Connection to tcp://127.0.0.1:1 failed: Error number -138 occurred",
      URL_SOURCE,
      "transient",
    ],
    [
      "[tcp @ 0] Connection to tcp://10.0.0.1:9000 failed: Connection refused",
      URL_SOURCE,
      "transient",
    ],
    ["[http @ 0] Error reading HTTP response: End of file", URL_SOURCE, "transient"],
    ["[out#0/mp4 @ 0] Error writing trailer: No space left on device", URL_SOURCE, "transient"],
    [
      "[in#0/mov @ 0] Error during demuxing: I/O error\n[dec:aac @ 0] Error submitting packet to decoder: Invalid data found when processing input",
      URL_SOURCE,
      "transient",
    ],
    [
      "[in#0 @ 0] moov atom not found\nError opening input: Invalid data found when processing input",
      URL_SOURCE,
      "unreadable",
    ],
    ["Decoder (codec av1) not found for input stream #0:0", URL_SOURCE, "unreadable"],
    ["", URL_SOURCE, "transient"],
    ["something nobody has seen before", URL_SOURCE, "transient"],
  ])("reads %j (source %j) as %s", (stderr, source, kind) => {
    expect(classifyReadFailure(stderr, source)).toBe(kind);
  });
});

describe.skipIf(!CAN_RUN)("processClip", () => {
  it("cuts a mezzanine MP4 successfully and returns defined terminal success outcome", async () => {
    const { context: ctx, derived, progress } = buildContext(video);

    const outcome = await processClip(ctx);
    const result = outcome.result as Record<string, unknown>;

    expect(result["schemaVersion"]).toBe(1);
    expect(result["clipId"]).toBe(CLIP_ID);
    expect(result["bucket"]).toBe("s3");
    expect(result["key"]).toBe(`ws/${WS}/clips/${CLIP_ID}/master.mp4`);
    expect(result["sizeBytes"]).toBeGreaterThan(0);
    expect(result["durationMs"]).toBeGreaterThan(1_500);
    expect(result["checksum"]).toMatch(/^[a-f0-9]{64}$/);
    expect(derived.written.has(`ws/${WS}/clips/${CLIP_ID}/master.mp4`)).toBe(true);
    expect(progress).toContain(100);
  }, 120_000);

  // 2026-09-25: the mezzanine had Arial captions burned in, so every caption the
  // editor drew on the clip project sat on top of a second, uneditable set.
  it("cuts a clean picture even when an old payload still carries subtitles", async () => {
    const kept = join(dir, "kept-mezzanine.mp4");
    const legacy = {
      subtitles: [{ startMs: 500, endMs: 2_500, text: "BURNED IN CAPTION TEXT" }],
    } as Partial<ClipPayload>;
    const { context: ctx } = buildContext(flat, legacy, keepingStore(flat, kept));

    await processClip(ctx);

    const luma = lumaAt1s(kept);
    // A 1280 x 720 source keeps its full height: a 406 x 720 picture.
    expect(luma.length).toBe(406 * 720);
    // Flat mid-blue is ~luma 80; white caption text would be ~235.
    expect(countAbove(luma, 140)).toBe(0);
  }, 120_000);

  // 2026-09-26: the window was always the frame centre, so a speaker sitting
  // right of centre was cut out of the clip before captions ever saw them.
  it("centres the 9:16 window on reframe.centerX", async () => {
    const kept = join(dir, "kept-reframed.mp4");
    const { context: ctx } = buildContext(
      boxed,
      { reframe: { centerX: 0.8125, basis: "faces" } },
      keepingStore(boxed, kept),
    );

    await processClip(ctx);

    // The whole 96 x 120 box is in the picture.
    expect(countAbove(lumaAt1s(kept), 200)).toBeGreaterThan(10_000);
  }, 120_000);

  it("keeps the frame centre when the payload has no reframe", async () => {
    const kept = join(dir, "kept-centred.mp4");
    const { context: ctx } = buildContext(boxed, {}, keepingStore(boxed, kept));

    await processClip(ctx);

    expect(countAbove(lumaAt1s(kept), 200)).toBe(0);
  }, 120_000);

  it("pans smoothly across the frame when reframe.trajectory is supplied", async () => {
    const kept = join(dir, "kept-trajectory.mp4");
    const { context: ctx } = buildContext(
      boxed,
      {
        reframe: {
          centerX: 0.8125,
          basis: "faces",
          trajectory: {
            interpolation: "SPRING_DAMPED",
            keyframes: [
              { timeSec: 0, centerX: 0.78, centerY: 0.5, zoom: 1 },
              { timeSec: 1.0, centerX: 0.8125, centerY: 0.5, zoom: 1 },
              { timeSec: 2.0, centerX: 0.82, centerY: 0.5, zoom: 1 },
            ],
          },
        },
      },
      keepingStore(boxed, kept),
    );

    await processClip(ctx);

    // At t = 1s, the dynamic crop expression pans onto the white box at centerX = 0.8125.
    expect(countAbove(lumaAt1s(kept), 200)).toBeGreaterThan(10_000);
  }, 120_000);

  // Was 720 x 1280 whatever was asked: every 1080 x 1920 export scaled it up.
  it("does not upscale: a 720p source makes a 406 x 720 mezzanine", async () => {
    const kept = join(dir, "kept-native.mp4");
    const { context: ctx } = buildContext(video, {}, keepingStore(video, kept));

    await processClip(ctx);

    expect(dimensions(kept)).toEqual({ width: 406, height: 720 });
  }, 120_000);

  it("scales down to profile.maxHeight when the crop is taller", async () => {
    const kept = join(dir, "kept-small.mp4");
    const { context: ctx } = buildContext(
      video,
      { profile: { container: "mp4", videoCodec: "h264", audioCodec: "aac", maxHeight: 360 } },
      keepingStore(video, kept),
    );

    await processClip(ctx);

    expect(dimensions(kept)).toEqual({ width: 202, height: 360 });
  }, 120_000);

  // A fixed 202 x 360 crop does not fit the 320 x 180 half, and ffmpeg failed
  // the cut ("Error reinitializing filters!") on every attempt.
  it("cuts a source whose picture size changes mid-stream", async () => {
    const kept = join(dir, "kept-resized.mp4");
    const { context: ctx } = buildContext(resized, {}, keepingStore(resized, kept));

    // The default interval, 0.3 s to 2.7 s, crosses the change at 2 s.
    const result = (await processClip(ctx)).result;

    expect(dimensions(kept)).toEqual({ width: 202, height: 360 });
    expect(result["durationMs"]).toBeGreaterThan(2_000);
  }, 120_000);

  describe("stacked (2026-10-01)", () => {
    /** The two boxes of `twoBoxed`, as the API would name them from a face track. */
    const left = { centerX: 144 / 640, centerY: 140 / 360, size: 80 / 360 };
    const right = { centerX: 496 / 640, centerY: 150 / 360, size: 80 / 360 };
    const stacked = {
      reframe: { centerX: left.centerX, basis: "faces", layout: "stacked", people: [left, right] },
    } as Partial<ClipPayload>;
    // After the encode: white is ~235, the mid-grey box ~126, the field ~44.
    const white = (luma: Buffer, width: number, from: number, to: number) =>
      countInRows(luma, width, from, to, 200, 255);
    const grey = (luma: Buffer, width: number, from: number, to: number) =>
      countInRows(luma, width, from, to, 100, 150);

    it("puts each person in their own half, the left one on top", async () => {
      const kept = join(dir, "kept-stacked.mp4");
      const { context: ctx } = buildContext(twoBoxed, stacked, keepingStore(twoBoxed, kept));

      await processClip(ctx);

      // 9:8 halves of the 640 x 360 source, never scaled up: 320 x 284 each.
      expect(dimensions(kept)).toEqual({ width: 320, height: 568 });
      const luma = lumaAt1s(kept);
      // The whole 64 x 80 white box is in the top half, and none of the grey one...
      expect(white(luma, 320, 0, 284)).toBeGreaterThan(4_000);
      expect(grey(luma, 320, 0, 284)).toBeLessThan(200);
      // ...and the grey box is in the bottom half, with none of the white one.
      expect(grey(luma, 320, 284, 568)).toBeGreaterThan(4_000);
      expect(white(luma, 320, 284, 568)).toBeLessThan(200);
    }, 120_000);

    it("stacks a 4:5 cut the same way, in 8:5 halves", async () => {
      const kept = join(dir, "kept-stacked-4x5.mp4");
      const { context: ctx } = buildContext(
        twoBoxed,
        {
          ...stacked,
          aspect: "4:5",
          profile: { container: "mp4", videoCodec: "h264", audioCodec: "aac", maxHeight: 1_350 },
        },
        keepingStore(twoBoxed, kept),
      );

      await processClip(ctx);

      expect(dimensions(kept)).toEqual({ width: 320, height: 400 });
      const luma = lumaAt1s(kept);
      expect(white(luma, 320, 0, 200)).toBeGreaterThan(4_000);
      expect(grey(luma, 320, 0, 200)).toBeLessThan(200);
      expect(grey(luma, 320, 200, 400)).toBeGreaterThan(4_000);
      expect(white(luma, 320, 200, 400)).toBeLessThan(200);
    }, 120_000);

    // The single-window cut's failure (2026-09-26), for two windows: each half's
    // crop must still fit once the picture shrinks to 320 x 180.
    it("cuts a stacked source whose picture size changes mid-stream", async () => {
      const kept = join(dir, "kept-stacked-resized.mp4");
      const { context: ctx } = buildContext(
        resized,
        {
          reframe: {
            centerX: 0.25,
            basis: "faces",
            layout: "stacked",
            people: [
              { centerX: 0.25, centerY: 0.4, size: 0.2 },
              { centerX: 0.75, centerY: 0.4, size: 0.2 },
            ],
          },
        },
        keepingStore(resized, kept),
      );

      const result = (await processClip(ctx)).result;

      expect(dimensions(kept)).toEqual({ width: 320, height: 568 });
      expect(result["durationMs"]).toBeGreaterThan(2_000);
    }, 120_000);

    it("cuts one window when the stack cannot be made, rather than fail the clip", async () => {
      const kept = join(dir, "kept-stacked-square.mp4");
      // Never sent by the API (the contract refuses it), but a worker checks.
      const { context: ctx } = buildContext(
        twoBoxed,
        {
          ...stacked,
          aspect: "1:1",
          profile: { container: "mp4", videoCodec: "h264", audioCodec: "aac", maxHeight: 1_080 },
        },
        keepingStore(twoBoxed, kept),
      );

      await processClip(ctx);

      // A square window centred on the dominant speaker (`reframe.centerX`).
      expect(dimensions(kept)).toEqual({ width: 360, height: 360 });
      const luma = lumaAt1s(kept);
      expect(white(luma, 360, 0, 360)).toBeGreaterThan(4_000);
    }, 120_000);
  });

  it("cuts an audio-only source to an audio-only mezzanine", async () => {
    const kept = join(dir, "kept-audio.mp4");
    const { context: ctx } = buildContext(audioOnly, {}, keepingStore(audioOnly, kept));

    const outcome = await processClip(ctx);

    expect(outcome.result["hasAudio"]).toBe(true);
    expect(hasVideoStream(kept)).toBe(false);
    // No audiogram was asked for, so the result says nothing about a picture:
    // an API from before audiograms would refuse the field.
    expect(outcome.result).not.toHaveProperty("picture");
  }, 120_000);

  describe("audiograms (2026-10-04)", () => {
    const ARTWORK_KEY = `ws/${WS}/brand/01JCC0VER00000000000000000.png`;
    let artwork = "";

    beforeAll(() => {
      artwork = join(dir, "cover.png");
      generate([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=white:size=240x240",
        "-frames:v",
        "1",
        artwork,
      ]);
    });

    /** A store whose signed URLs are the source for its key and the artwork for its own. */
    function storeWith(source: string, art: string, kept: string): FakeStore {
      const store = fakeStore((key) => (key === ARTWORK_KEY ? art : source));
      return {
        ...store,
        putFile: async (input) => {
          await copyFile(input.file, kept);
          return store.putFile(input);
        },
      };
    }

    const audiogram = {
      background: "#141217",
      accent: "#f1ece6",
      artwork: { key: ARTWORK_KEY, format: "png" },
    };

    it("draws a picture at the shape's size for a source with none, and says so", async () => {
      const kept = join(dir, "kept-audiogram.mp4");
      const { context: ctx } = buildContext(
        audioOnly,
        { audiogram },
        storeWith(audioOnly, artwork, kept),
      );

      const outcome = await processClip(ctx);

      expect(outcome.result["picture"]).toBe("audiogram");
      expect(outcome.result["hasAudio"]).toBe(true);
      expect(dimensions(kept)).toEqual({ width: 1_080, height: 1_920 });
      // The white artwork is in its square, above the waveform.
      const layout = audiogramLayout({ width: 1_080, height: 1_920 }, { artwork: true });
      const art = layout.artwork ?? { y: 0, height: 0 };
      expect(
        countInRows(lumaAt1s(kept), 1_080, art.y, art.y + art.height, 201, 255),
      ).toBeGreaterThan(20_000);
    }, 120_000);

    it("draws each format at its own size", async () => {
      const kept = join(dir, "kept-audiogram-wide.mp4");
      const { context: ctx } = buildContext(
        audioOnly,
        {
          audiogram,
          aspect: "16:9",
          profile: { container: "mp4", videoCodec: "h264", audioCodec: "aac", maxHeight: 1_080 },
        },
        storeWith(audioOnly, artwork, kept),
      );

      await processClip(ctx);

      expect(dimensions(kept)).toEqual({ width: 1_920, height: 1_080 });
    }, 120_000);

    it("draws the waveform alone when the artwork cannot be read", async () => {
      const kept = join(dir, "kept-audiogram-noart.mp4");
      const { context: ctx } = buildContext(
        audioOnly,
        { audiogram },
        storeWith(audioOnly, join(dir, "no-such-cover.png"), kept),
      );

      const outcome = await processClip(ctx);

      expect(outcome.result["picture"]).toBe("audiogram");
      expect(dimensions(kept)).toEqual({ width: 1_080, height: 1_920 });
      // No white square: nothing light above the waveform, which is drawn on
      // its own (larger, lower) where the artwork and its waveform would be.
      const alone = audiogramLayout({ width: 1_080, height: 1_920 }, { artwork: false });
      expect(countInRows(lumaAt1s(kept), 1_080, 0, alone.waveform.y, 201, 255)).toBe(0);
    }, 120_000);

    it("cuts a source's own picture when it turns out to have one, and says so", async () => {
      const kept = join(dir, "kept-audiogram-video.mp4");
      const { context: ctx } = buildContext(video, { audiogram }, storeWith(video, artwork, kept));

      const outcome = await processClip(ctx);

      expect(outcome.result["picture"]).toBe("source");
      // The 720p source's own 9:16 window, not a drawn 1080 x 1920 picture.
      expect(dimensions(kept)).toEqual({ width: 406, height: 720 });
    }, 120_000);

    it("refuses artwork from another workspace before reading anything", async () => {
      const { context: ctx } = buildContext(audioOnly, {
        audiogram: {
          ...audiogram,
          artwork: { key: "ws/01JCOTHERWS00000000000000/brand/x.png", format: "png" },
        },
      });

      const error = await failureOf(ctx);

      expect(error.code).toBe("media/unreadable");
      expect(error.retryable).toBe(false);
    });

    it("refuses a payload naming a field this worker does not know, and is not retried", async () => {
      const { context: ctx } = buildContext(audioOnly, {
        ...({ sparkle: { on: true } } as Partial<ClipPayload>),
      });

      const error = await failureOf(ctx);

      expect(error.code).toBe("worker/outdated");
      expect(error.retryable).toBe(false);
      expect(error.message).toContain("sparkle");
    });
  });

  it("caps the tail handle at the source's measured end, not the payload's claim", async () => {
    const { context: ctx } = buildContext(video, {
      sourceDurationMs: 60_000,
      startMs: 3_000,
      endMs: 3_900,
      handleMs: 500,
    });

    const result = (await processClip(ctx)).result;

    // The fixture is ~4 s long, so at most ~100 ms of tail exists.
    expect(result["tailHandleMs"]).toBeLessThan(200);
    expect(result["effectiveEndMs"]).toBeLessThan(4_100);
  }, 120_000);

  // `effectiveEndMs` is what the cut reached. It used to be `endMs` plus the
  // tail even when the source ended first: 5 000 ms here, for a 4 s file.
  it("reports an end no later than the source's measured end", async () => {
    const { context: ctx } = buildContext(video, {
      sourceDurationMs: 60_000,
      startMs: 3_000,
      endMs: 5_000,
      handleMs: 200,
    });

    const result = (await processClip(ctx)).result;

    expect(result["tailHandleMs"]).toBe(0);
    expect(result["effectiveEndMs"]).toBeLessThan(4_100);
    const span = (result["effectiveEndMs"] as number) - (result["effectiveStartMs"] as number);
    expect(Math.abs((result["durationMs"] as number) - span)).toBeLessThan(200);
  }, 120_000);

  it("refuses a clip that starts after the source ends", async () => {
    const { context: ctx } = buildContext(video, {
      sourceDurationMs: 60_000,
      startMs: 10_000,
      endMs: 12_000,
    });

    const error = await failureOf(ctx);
    expect(error.retryable).toBe(false);
    expect(error.reason).toBe("media/unsupported");
  }, 120_000);

  it("refuses a profile with no usable height", async () => {
    const { context: ctx } = buildContext(video, {
      profile: { container: "mp4", videoCodec: "h264", audioCodec: "aac", maxHeight: 0 },
    });

    const error = await failureOf(ctx);
    expect(error.retryable).toBe(false);
  }, 120_000);

  it("reads the source over HTTP, reconnecting when a connection drops mid-read", async () => {
    const url = `${origin}/drop/source.mp4`;
    const { context: ctx } = buildContext(
      url,
      {},
      fakeStore(() => url),
    );

    const result = (await processClip(ctx)).result;

    // Without the reconnect options ffmpeg exits 0 with a file it cannot say
    // the length of; with them it asks again from where it stopped.
    const expected = (result["effectiveEndMs"] as number) - (result["effectiveStartMs"] as number);
    expect(result["durationMs"]).toBeGreaterThan(expected - 300);
  }, 120_000);

  it("retries when the store answers 5xx", async () => {
    const url = `${origin}/503/source.mp4?X-Amz-Signature=secret`;
    const { context: ctx } = buildContext(
      url,
      {},
      fakeStore(() => url),
    );

    const error = await failureOf(ctx);
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("media/source_unavailable");
    // The signed query string never reaches the job's error.
    expect(error.detail ?? "").toContain("Server returned 5XX");
    expect(error.detail ?? "").not.toContain("secret");
  }, 120_000);

  it("answers once when the source object is gone (404)", async () => {
    const url = `${origin}/404/source.mp4?X-Amz-Signature=secret`;
    const { context: ctx } = buildContext(
      url,
      {},
      fakeStore(() => url),
    );

    const error = await failureOf(ctx);
    expect(error.retryable).toBe(false);
    expect(error.code).toBe("media/source_missing");
    expect(error.detail ?? "").not.toContain("secret");
  }, 120_000);

  // The cases above all fail in the probe. These fail in the CUT: the probe's
  // one request is served, and the store refuses the encode's.
  it("retries when the store answers 5xx to the cut", async () => {
    const url = `${origin}/once-503/cut/source.mp4?X-Amz-Signature=secret`;
    const { context: ctx, progress } = buildContext(
      url,
      {},
      fakeStore(() => url),
    );

    const error = await failureOf(ctx);
    expect(progress).toContain(25);
    expect(requestsByPath.get("/once-503/cut/source.mp4")).toBeGreaterThan(1);
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("media/encode_failed");
    expect(error.detail ?? "").toContain("Server returned 5XX");
    expect(error.detail ?? "").not.toContain("secret");
  }, 120_000);

  it("answers once when the source object is gone by the time of the cut (404)", async () => {
    const url = `${origin}/once-404/cut/source.mp4?X-Amz-Signature=secret`;
    const { context: ctx, progress } = buildContext(
      url,
      {},
      fakeStore(() => url),
    );

    const error = await failureOf(ctx);
    expect(progress).toContain(25);
    expect(requestsByPath.get("/once-404/cut/source.mp4")).toBeGreaterThan(1);
    expect(error.retryable).toBe(false);
    expect(error.code).toBe("media/source_missing");
  }, 120_000);

  // "No such file or directory" about the OUTPUT used to read as the source
  // being gone: a permanent failure telling the user to pick another video.
  it("retries when the cut cannot open its output because the workspace went away", async () => {
    const tempDir = join(dir, "vanishing-workspace");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test workspace in the temporary directory
    await mkdir(tempDir, { recursive: true });
    const { context: ctx } = buildContext(video, {}, undefined, { tempDir }, (value) => {
      if (value !== 25) return;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test workspace in the temporary directory
      for (const entry of readdirSync(tempDir)) {
        rmSync(join(tempDir, entry), { recursive: true, force: true });
      }
    });

    const error = await failureOf(ctx);
    expect(error.detail ?? "").toContain("Error opening output");
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("media/encode_failed");
  }, 120_000);

  it("retries a cut that came out short because the source stopped arriving", async () => {
    const { context: ctx } = buildContext(truncated, {
      sourceDurationMs: 10_000,
      startMs: 1_000,
      endMs: 9_000,
    });

    const error = await failureOf(ctx);
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("media/encode_incomplete");
  }, 120_000);

  // The probe's budget is the smaller of the two, so a 1 ms budget kills
  // ffprobe, and the cut never starts.
  it("retries when ffprobe is killed by its timeout reading the source", async () => {
    const { context: ctx, progress } = buildContext(video, {}, undefined, { ffmpegTimeoutMs: 1 });

    const error = await failureOf(ctx);
    expect(progress).not.toContain(25);
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("media/tool_timeout");
  }, 120_000);

  it("stops a cut in progress when the worker shuts down, and uploads nothing", async () => {
    const url = `${origin}/stall/cut/source.mp4`;
    const { context: ctx, derived } = buildContext(
      url,
      {},
      fakeStore(() => url),
      {},
      (value, abort) => {
        // The cut is waiting on a request the store never answers.
        if (value === 25) setTimeout(() => abort.abort(), 100);
      },
    );

    const error = await failureOf(ctx);
    // `run`'s kill, not the guard in front of it.
    expect(error.message).toBe("ffmpeg was cancelled");
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("media/cancelled");
    expect(derived.written.size).toBe(0);
  }, 120_000);

  // `run` listens for an abort; one that already happened never fires, and the
  // cut used to run to the end and upload for a worker that was going away.
  it("does not start the cut when the worker is already shutting down", async () => {
    const { context: ctx, derived } = buildContext(video, {}, undefined, {}, (value, abort) => {
      if (value === 25) abort.abort();
    });

    const error = await failureOf(ctx);
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("media/cancelled");
    expect(derived.written.size).toBe(0);
  }, 120_000);

  // Used to be recorded as `media/encode_incomplete`: a cut that came out short.
  it("keeps the cancellation when the worker stops while the cut is measured", async () => {
    const { context: ctx, derived } = buildContext(video, {}, undefined, {}, (value, abort) => {
      // After the read-back ffprobe has started, before it can finish.
      if (value === 70) queueMicrotask(() => abort.abort());
    });

    const error = await failureOf(ctx);
    expect(error.message).toBe("ffprobe was cancelled");
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("media/cancelled");
    expect(derived.written.size).toBe(0);
  }, 120_000);

  it("refuses a missing source object with a terminal error", async () => {
    const nonExistentPath = join(dir, "non-existent-source.mp4");
    const { context: ctx } = buildContext(nonExistentPath);

    const error = await failureOf(ctx);
    expect(error.retryable).toBe(false);
    expect(error.code).toBe("media/source_missing");
    expect(error.reason).toBe("media/unsupported");
  }, 120_000);

  it("refuses an unreadable/corrupt source with a terminal error", async () => {
    const { context: ctx } = buildContext(corrupt);

    const error = await failureOf(ctx);
    expect(error.retryable).toBe(false);
    // ffprobe's own answer: the probe now runs before the cut.
    expect(["media/unsupported", "media/no_streams"]).toContain(error.reason);
  }, 120_000);

  it("refuses an invalid time range with a terminal error", async () => {
    const { context: ctx } = buildContext(video, {
      startMs: 3_000,
      endMs: 1_000, // endMs < startMs
    });

    const error = await processClip(ctx).catch((caught: unknown) => caught as MediaJobError);
    expect(error).toBeInstanceOf(MediaJobError);
    if (!(error instanceof MediaJobError)) throw error;
    expect(error.retryable).toBe(false);
    expect(error.reason).toBe("media/unsupported");
  }, 120_000);
});

describe("splitScreenFrame, splitScreenFilter, toSplitScreenConfig (Pillar 3 §02)", () => {
  const fullHd = { width: 1920, height: 1080 };
  const config: SplitScreenConfig = {
    enabled: true,
    topCrop: { x: 80, y: 180, width: 640, height: 720 },
    bottomCrop: { x: 1200, y: 180, width: 640, height: 720 },
    dividerColor: "#1A1A1A",
    activeSpeakerHighlight: true,
  };

  it("computes a 1080x1920 vertical canvas with two 1080x960 panes and a 2px divider line", () => {
    const frame = splitScreenFrame(fullHd, config, { maxHeight: 1920 });
    expect(frame).not.toBeNull();
    if (frame === null) return;
    expect(frame.half).toEqual({ width: 1080, height: 960 });
    expect(frame.output).toEqual({ width: 1080, height: 1920 });
    expect(frame.crops).toEqual([
      { x: 80, y: 180, width: 640, height: 720 },
      { x: 1200, y: 180, width: 640, height: 720 },
    ]);

    const filter = splitScreenFilter(frame);
    expect(filter).toContain("[top_in]crop=w=640:h=720:x=80:y=180,scale=1080:960:flags=bicubic,setsar=1[top]");
    expect(filter).toContain("[bottom_in]crop=w=640:h=720:x=1200:y=180,scale=1080:960:flags=bicubic,setsar=1[bottom]");
    expect(filter).toContain("[top][bottom]vstack=inputs=2[stacked]");
    expect(filter).toContain("drawbox=y=959:color=#1A1A1A:width=1080:height=2:t=fill");
  });

  it("converts a StackedFrame into a SplitScreenConfig and rejects disabled or non-landscape sources", () => {
    const stacked = stackedFrame(fullHd, {
      people: [
        { centerX: 0.25, centerY: 0.4, size: 0.14 },
        { centerX: 0.75, centerY: 0.42, size: 0.14 },
      ],
    });
    expect(stacked).not.toBeNull();
    if (stacked === null) return;
    const derivedConfig = toSplitScreenConfig(stacked);
    expect(derivedConfig.enabled).toBe(true);
    expect(derivedConfig.topCrop).toEqual(stacked.crops[0]);
    expect(derivedConfig.bottomCrop).toEqual(stacked.crops[1]);

    expect(splitScreenFrame(fullHd, { ...config, enabled: false })).toBeNull();
    expect(splitScreenFrame({ width: 1080, height: 1920 }, config)).toBeNull();
  });
});

