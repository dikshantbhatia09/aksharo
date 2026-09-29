import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { processStills, stillFilter } from "./stills.js";
import { MediaJobError } from "../errors.js";

import type { StillRequest, StillsPayload } from "./stills.js";
import type { JobContext } from "../runtime.js";
import type { Settings } from "../settings.js";
import type { ObjectStore } from "../storage.js";

const WS = "01JCWS0000000000000000000A";
const CLIP_ID = "01JCCLIP00000000000000000";

const CAN_RUN =
  spawnSync("ffmpeg", ["-version"], { stdio: "pipe", shell: true, timeout: 20_000 }).status === 0;
if (!CAN_RUN) console.warn("[stills.test] skipped — ffmpeg is not on PATH.");

function generate(args: readonly string[]): void {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`fixture failed:\n${result.stderr ?? ""}`);
}

function dimensions(file: string): { width: number; height: number } {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { stdio: "pipe", encoding: "utf8", timeout: 60_000 },
  );
  const [width, height] = probe.stdout.trim().split(",").map(Number);
  return { width: width ?? 0, height: height ?? 0 };
}

/** Mean luma of the top and bottom quarter of an image. */
function lumaBands(file: string): { top: number; bottom: number } {
  const { width, height } = dimensions(file);
  const frame = spawnSync(
    "ffmpeg",
    ["-nostdin", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { stdio: "pipe", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const luma = frame.stdout as Buffer;
  const band = (from: number, to: number): number => {
    let sum = 0;
    for (let i = from * width; i < to * width; i += 1) sum += luma.readUInt8(i);
    return sum / ((to - from) * width);
  };
  return {
    top: band(0, Math.floor(height / 4)),
    bottom: band(height - Math.floor(height / 4), height),
  };
}

interface Kept extends ObjectStore {
  readonly written: Map<string, string>;
}

let dir = "";
let video = "";
let split = "";

/** A store whose signed URLs are local files, and which keeps every JPEG. */
function store(source: string): Kept {
  const written = new Map<string, string>();
  let count = 0;
  return {
    bucket: "montaj-derived",
    kind: "r2",
    written,
    presignGet: async () => source,
    putFile: async ({ key, file }) => {
      count += 1;
      const kept = join(dir, `kept-${String(count)}.jpg`);
      await copyFile(file, kept);
      written.set(key, kept);
      return 1;
    },
    putBody: async () => 0,
  };
}

function contextFor(payload: StillsPayload, derived: ObjectStore): JobContext {
  const settings = {
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    tempDir: undefined,
    sourceUrlTtlSeconds: 3_600,
    ffmpegTimeoutMs: 120_000,
  } as unknown as Settings;
  return {
    settings,
    envelope: {
      jobId: "01JCJ0B0000000000000000000",
      attemptId: "01JCATTEMPT000000000000000",
      workspaceId: WS,
      projectId: "01JCPR0JECT000000000000000",
      priority: 3,
      jobKey: `media.stills:${CLIP_ID}`,
      createdAt: "2026-09-29T00:00:00.000Z",
      payload: payload as never,
    },
    payload: payload as never,
    derivedPrefix: `ws/${WS}`,
    raw: derived,
    derived,
    callbacks: {} as JobContext["callbacks"],
    report: () => undefined,
    signal: new AbortController().signal,
  };
}

function payloadOf(images: StillRequest[]): StillsPayload {
  return {
    schemaVersion: 1,
    runId: "01JCRUN0000000000000000000",
    clipId: CLIP_ID,
    destination: { bucket: "s3", key: `ws/${WS}/clips/${CLIP_ID}/images/` },
    images,
    fingerprint: "exports:a,b",
  };
}

const image = (overrides: Partial<StillRequest>): StillRequest => ({
  name: "thumbnail-1",
  sourceKey: "ws/x/export.mp4",
  atMs: 1_000,
  width: 320,
  height: 180,
  destinationKey: `ws/${WS}/clips/${CLIP_ID}/images/thumbnail-1.jpg`,
  ...overrides,
});

beforeAll(async () => {
  if (!CAN_RUN) return;
  dir = await mkdtemp(join(tmpdir(), "stills-test-"));
  video = join(dir, "source.mp4");
  generate([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=25",
    "-t",
    "3",
    "-pix_fmt",
    "yuv420p",
    video,
  ]);
  // White top half, black bottom half: where a crop sits down the picture shows.
  split = join(dir, "split.mp4");
  generate([
    "-f",
    "lavfi",
    "-i",
    "color=c=black:size=640x360:rate=25",
    "-vf",
    "drawbox=x=0:y=0:w=640:h=180:color=white:t=fill",
    "-t",
    "2",
    "-pix_fmt",
    "yuv420p",
    split,
  ]);
}, 120_000);

afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

describe("stillFilter", () => {
  it("covers the size, crops across the middle and down at the focus", () => {
    expect(stillFilter({ width: 1702, height: 630, focusY: 0.25 })).toBe(
      "scale=1702:630:force_original_aspect_ratio=increase," +
        "crop=1702:630:(iw-ow)/2:min(max(ih*0.2500-oh/2\\,0)\\,ih-oh),setsar=1",
    );
    expect(stillFilter({ width: 100, height: 100 })).toContain("ih*0.5000");
  });
});

describe.skipIf(!CAN_RUN)("processStills", () => {
  it("makes every image at its size and reports each one", async () => {
    const derived = store(video);
    const images = [
      image({ name: "thumbnail-1", width: 320, height: 180 }),
      image({
        name: "carousel-1",
        atMs: 500,
        width: 216,
        height: 270,
        destinationKey: `ws/${WS}/clips/${CLIP_ID}/images/carousel-1.jpg`,
      }),
      image({
        name: "pin-1",
        atMs: 2_000,
        width: 200,
        height: 300,
        destinationKey: `ws/${WS}/clips/${CLIP_ID}/images/pin-1.jpg`,
      }),
    ];

    const outcome = await processStills(contextFor(payloadOf(images), derived));

    const result = outcome.result as {
      clipId: string;
      fingerprint: string;
      images: { name: string; key: string; width: number; height: number; sizeBytes: number }[];
    };
    expect(result.clipId).toBe(CLIP_ID);
    expect(result.fingerprint).toBe("exports:a,b");
    expect(result.images.map((row) => row.name)).toEqual(["thumbnail-1", "carousel-1", "pin-1"]);
    for (const request of images) {
      const kept = derived.written.get(request.destinationKey);
      expect(kept).toBeDefined();
      expect(dimensions(kept ?? "")).toEqual({ width: request.width, height: request.height });
    }
    expect(result.images.every((row) => row.sizeBytes > 0)).toBe(true);
  }, 120_000);

  // A banner is far wider than the video: the crop keeps a band, and focusY
  // says which one (the API sends the face's height).
  it("crops down the picture at focusY", async () => {
    const derived = store(split);
    const top = image({
      name: "banner-top",
      width: 640,
      height: 120,
      focusY: 0,
      destinationKey: "k/top.jpg",
    });
    const bottom = image({
      name: "banner-bottom",
      width: 640,
      height: 120,
      focusY: 1,
      destinationKey: "k/bottom.jpg",
    });

    await processStills(contextFor(payloadOf([top, bottom]), derived));

    const high = lumaBands(derived.written.get("k/top.jpg") ?? "");
    const low = lumaBands(derived.written.get("k/bottom.jpg") ?? "");
    expect(high.top).toBeGreaterThan(200);
    expect(high.bottom).toBeGreaterThan(200);
    expect(low.top).toBeLessThan(40);
    expect(low.bottom).toBeLessThan(40);
  }, 120_000);

  it("refuses a frame past the end of the video rather than storing nothing", async () => {
    const derived = store(video);
    const error = await processStills(
      contextFor(payloadOf([image({ atMs: 60_000 })]), derived),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MediaJobError);
    expect(derived.written.size).toBe(0);
  }, 120_000);
});

describe("processStills payload", () => {
  it.each([
    ["no images", []],
    ["a name that could leave the folder", [image({ name: "../x" })]],
    ["a size too large", [image({ width: 10_000 })]],
    ["a focus outside the picture", [image({ focusY: 2 })]],
  ])("refuses %s", async (_label, images) => {
    const error = await processStills(
      contextFor(payloadOf(images as StillRequest[]), store("")),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MediaJobError);
    expect((error as MediaJobError).retryable).toBe(false);
  });
});
