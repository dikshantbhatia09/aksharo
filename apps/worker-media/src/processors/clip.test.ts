import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { processClip } from "./clip.js";
import { MediaJobError } from "../errors.js";

import type { ClipPayload } from "./clip.js";
import type { JobContext } from "../runtime.js";
import type { Settings } from "../settings.js";
import type { ObjectStore } from "../storage.js";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const RUN_ID = "01JCRUN0000000000000000000";
const CANDIDATE_ID = "01JCCANDIDATE000000000000";
const CLIP_ID = "01JCCLIP00000000000000000";

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

function buildContext(
  sourcePath: string,
  payloadOverrides: Partial<ClipPayload> = {},
  storeOverride?: FakeStore,
): {
  context: JobContext;
  derived: FakeStore;
  progress: number[];
} {
  const derived = storeOverride ?? fakeStore(() => sourcePath);
  const progress: number[] = [];
  const settings = {
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    tempDir: undefined,
    sourceUrlTtlSeconds: 3_600,
    ffmpegTimeoutMs: 120_000,
    loudnessEnabled: true,
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
      report: (value) => progress.push(value),
      signal: new AbortController().signal,
    },
  };
}

let dir = "";
let video = "";
let flat = "";
let corrupt = "";

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
}, 180_000);

afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
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
    const store = fakeStore(() => flat);
    const keeping: FakeStore = {
      ...store,
      putFile: async (input) => {
        await copyFile(input.file, kept);
        return store.putFile(input);
      },
    };
    const legacy = {
      subtitles: [{ startMs: 500, endMs: 2_500, text: "BURNED IN CAPTION TEXT" }],
    } as Partial<ClipPayload>;
    const { context: ctx } = buildContext(flat, legacy, keeping);

    await processClip(ctx);

    const frame = spawnSync(
      "ffmpeg",
      ["-nostdin", "-loglevel", "error", "-ss", "1", "-i", kept, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
      { stdio: "pipe", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    expect(frame.status).toBe(0);
    const luma = frame.stdout as Buffer;
    expect(luma.length).toBe(720 * 1280);
    // Flat mid-blue is ~luma 80; white caption text would be ~235.
    let brightest = 0;
    for (const value of luma) if (value > brightest) brightest = value;
    expect(brightest).toBeLessThan(140);
  }, 120_000);

  it("refuses a missing source object with a terminal error", async () => {
    const nonExistentPath = join(dir, "non-existent-source.mp4");
    const { context: ctx } = buildContext(nonExistentPath);

    const error = await processClip(ctx).catch((caught: unknown) => caught as MediaJobError);
    expect(error).toBeInstanceOf(MediaJobError);
    if (!(error instanceof MediaJobError)) throw error;
    expect(error.retryable).toBe(false);
    expect(error.reason).toBe("media/unsupported");
  }, 120_000);

  it("refuses an unreadable/corrupt source on ffmpeg failure with a terminal error", async () => {
    const { context: ctx } = buildContext(corrupt);

    const error = await processClip(ctx).catch((caught: unknown) => caught as MediaJobError);
    expect(error).toBeInstanceOf(MediaJobError);
    if (!(error instanceof MediaJobError)) throw error;
    expect(error.retryable).toBe(false);
    expect(error.reason).toBe("media/probe_failed");
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
