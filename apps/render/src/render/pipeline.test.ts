/**
 * The end-to-end render: a ten-second synthetic clip, real captions from the
 * sample EDG, real Skia, real ffmpeg, and ffprobe on the result.
 *
 * These are the acceptance cases from the brief, and each one is a different
 * kind of assertion:
 *
 * - the **plain render** asserts the container: codec, resolution, duration,
 *   audio, faststart;
 * - the **cut render** asserts the timemap actually shortened the output;
 * - the **watermark render** asserts the manifest's decision reached the pixels;
 * - the **caps** and **signature** cases assert the two refusals, and assert
 *   that they cost nothing — no download, no ffmpeg;
 * - the **frame cache** case asserts that a static caption is rasterised once
 *   rather than thirty times a second.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isRenderManifestError } from "@montaj/render-manifest";
import { fixtureManifest } from "@montaj/render-manifest/testing";

import { renderVideo, type RenderDependencies } from "./pipeline.js";
import { rawKey } from "../storage.js";
import {
  createDirectoryStore,
  FIXTURE_IDS,
  makeSyntheticClip,
  makeWatermarkPng,
  removeQuietly,
  samplePayload,
  signedFixtureManifest,
  type DirectoryStore,
} from "../testing.js";

import type { RenderVideoPayload } from "../queues.js";

const run = promisify(execFile);

const SECRET = "a20-integration-secret";
/** 540×960 rather than 1080×1920: same code path, a quarter of the pixels. */
const WIDTH = 540;
const HEIGHT = 960;
const FPS = 12;
const CLIP_SECONDS = 10;

let scratch: string;
let rawStore: DirectoryStore;
let derivedStore: DirectoryStore;
let sourceKey: string;
let watermarkBytes: Uint8Array;

async function ffprobe(path: string): Promise<Record<string, unknown>> {
  const { stdout } = await run(
    "ffprobe",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      path,
    ],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

interface ProbeStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
}

function streams(probe: Record<string, unknown>): ProbeStream[] {
  return (probe["streams"] ?? []) as ProbeStream[];
}

function durationSeconds(probe: Record<string, unknown>): number {
  return Number((probe["format"] as { duration?: string } | undefined)?.duration ?? 0);
}

/** The manifest overrides every case shares: small canvas, low fps, our source. */
function baseOverrides(): Parameters<typeof signedFixtureManifest>[1] {
  return {
    source: {
      mediaId: FIXTURE_IDS.mediaId,
      bucket: "raw",
      key: sourceKey,
      durationMs: CLIP_SECONDS * 1000,
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
    },
    timemap: { sourceDurationMs: CLIP_SECONDS * 1000, edits: [], snapCutsToFrames: false },
    output: {
      kind: "video",
      preset: "custom",
      aspect: "9:16",
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      container: "mp4",
      videoCodec: "h264",
      crf: 30,
      encoderPreset: "ultrafast",
    },
    watermark: null,
  };
}

function dependencies(extra: Partial<RenderDependencies> = {}): RenderDependencies {
  return {
    rawStore,
    derivedStore,
    secret: SECRET,
    encoder: "libx264",
    workDir: scratch,
    resolveBrandAsset: () => Promise.resolve(watermarkBytes),
    ...extra,
  };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "a20-pipeline-"));
  rawStore = createDirectoryStore(join(scratch, "raw"), "montaj-raw");
  derivedStore = createDirectoryStore(join(scratch, "derived"), "montaj-derived");

  const clip = join(scratch, "clip.mp4");
  await makeSyntheticClip(clip, {
    seconds: CLIP_SECONDS,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
  });
  sourceKey = rawKey(FIXTURE_IDS.workspaceId, FIXTURE_IDS.projectId, FIXTURE_IDS.mediaId, "mp4");
  await rawStore.seed(sourceKey, clip);
  watermarkBytes = await makeWatermarkPng(join(scratch, "mark.png"));
}, 300_000);

afterAll(async () => {
  await removeQuietly(scratch);
});

describe("a whole cloud render", () => {
  it("burns the sample project's captions into a ten-second clip and writes it to R2", async () => {
    const payload = await samplePayload(SECRET, baseOverrides(), CLIP_SECONDS * 1000);
    const outcome = await renderVideo(payload, FIXTURE_IDS.workspaceId, dependencies());

    // CONTRACTS §6: exports live under the project's export prefix.
    expect(outcome.outputKey).toBe(
      `ws/${FIXTURE_IDS.workspaceId}/p/${FIXTURE_IDS.projectId}/exports/${FIXTURE_IDS.exportId}.mp4`,
    );
    expect(derivedStore.written.map((entry) => entry.key)).toContain(outcome.outputKey);
    expect(outcome.sizeBytes).toBeGreaterThan(1_000);

    const probe = await ffprobe(derivedStore.pathFor(outcome.outputKey));
    const video = streams(probe).find((stream) => stream.codec_type === "video");
    const audio = streams(probe).find((stream) => stream.codec_type === "audio");

    expect(video?.codec_name).toBe("h264");
    expect(video?.width).toBe(WIDTH);
    expect(video?.height).toBe(HEIGHT);
    expect(audio?.codec_name).toBe("aac");
    expect(durationSeconds(probe)).toBeGreaterThan(CLIP_SECONDS - 0.5);
    expect(durationSeconds(probe)).toBeLessThan(CLIP_SECONDS + 0.5);

    // `+faststart` moves the moov atom in front of the media data, so a
    // download plays before it finishes. ffprobe does not report it, but the
    // byte order does: `moov` must appear before `mdat`.
    const head = await readFile(derivedStore.pathFor(outcome.outputKey));
    const text = head.toString("latin1");
    expect(text.indexOf("moov")).toBeGreaterThan(-1);
    expect(text.indexOf("moov")).toBeLessThan(text.indexOf("mdat"));

    expect(outcome.frames.requested).toBe(CLIP_SECONDS * FPS);
    expect(outcome.fontSource).toBe("fixtures");
  }, 600_000);

  it("shortens the output by exactly the accepted cut", async () => {
    const overrides = baseOverrides();
    const payload = await samplePayload(
      SECRET,
      {
        ...overrides,
        timemap: {
          sourceDurationMs: CLIP_SECONDS * 1000,
          snapCutsToFrames: false,
          // Three seconds removed from the middle.
          edits: [{ kind: "cut", startMs: 3_000, endMs: 6_000 }],
        },
      },
      CLIP_SECONDS * 1000,
    );
    const outcome = await renderVideo(payload, FIXTURE_IDS.workspaceId, dependencies());

    expect(outcome.outputDurationMs).toBe(7_000);
    const probe = await ffprobe(derivedStore.pathFor(outcome.outputKey));
    expect(durationSeconds(probe)).toBeGreaterThan(6.5);
    expect(durationSeconds(probe)).toBeLessThan(7.5);
    expect(outcome.frames.requested).toBe(7 * FPS);
  }, 600_000);

  it("burns in the watermark the manifest asked for", async () => {
    const overrides = baseOverrides();
    const withMark = await samplePayload(
      SECRET,
      {
        ...overrides,
        watermark: { assetId: "aksharo-mark", position: "bottom-right", opacity: 0.9 },
      },
      CLIP_SECONDS * 1000,
    );
    const outcome = await renderVideo(withMark, FIXTURE_IDS.workspaceId, dependencies());
    expect(outcome.manifest.watermark).not.toBeNull();

    // The mark is a solid red square in the bottom-right eighth of the frame,
    // and `testsrc2` puts nothing red there, so a red-dominant pixel in that
    // corner is the mark and nothing else.
    const frame = join(scratch, "watermark-frame.png");
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        "1",
        "-i",
        derivedStore.pathFor(outcome.outputKey),
        "-frames:v",
        "1",
        "-vf",
        `crop=64:16:${String(WIDTH - 90)}:${String(HEIGHT - 40)},scale=1:1`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        frame,
      ],
      { timeout: 120_000, windowsHide: true },
    );
    const pixel = await readFile(frame);
    expect(pixel).toHaveLength(3);
    expect(pixel[0]).toBeGreaterThan((pixel[1] ?? 0) + 30);
    expect(pixel[0]).toBeGreaterThan((pixel[2] ?? 0) + 30);
  }, 600_000);

  it("rasterises far fewer frames than it writes, because captions hold still", async () => {
    const payload = await samplePayload(SECRET, baseOverrides(), CLIP_SECONDS * 1000);
    const outcome = await renderVideo(payload, FIXTURE_IDS.workspaceId, dependencies());

    expect(outcome.frames.rasterised).toBeLessThan(outcome.frames.requested);
    expect(outcome.frames.reused).toBe(outcome.frames.requested - outcome.frames.rasterised);
    // The sample project's captions are on screen for seconds at a time; the
    // gaps between them alone are identical empty frames.
    expect(outcome.frames.reuseRatio).toBeGreaterThan(0.1);
  }, 600_000);
});

describe("the rasteriser pool", () => {
  it("renders on worker threads by default and says how many", async () => {
    const payload = await samplePayload(SECRET, baseOverrides(), CLIP_SECONDS * 1000);
    const outcome = await renderVideo(payload, FIXTURE_IDS.workspaceId, dependencies());
    expect(outcome.rasterWorkers).toBeGreaterThan(0);
    expect(outcome.frames.requested).toBe(CLIP_SECONDS * FPS);
  }, 600_000);

  it("falls back to rasterising inline when the worker entry is missing", async () => {
    // A machine without worker threads, or an image that dropped
    // `workers/raster-worker.mjs`, must still render — just at A20's speed.
    const warnings: string[] = [];
    const payload = await samplePayload(SECRET, baseOverrides(), CLIP_SECONDS * 1000);
    const outcome = await renderVideo(payload, FIXTURE_IDS.workspaceId, {
      ...dependencies(),
      workerPath: join(scratch, "no-such-worker.mjs"),
      onWarning: (message) => warnings.push(message),
    });
    expect(outcome.rasterWorkers).toBe(0);
    expect(warnings.join(" ")).toContain("rasterising inline");
    const probe = await ffprobe(derivedStore.pathFor(outcome.outputKey));
    expect(streams(probe).find((stream) => stream.codec_type === "video")?.width).toBe(WIDTH);
  }, 600_000);

  it("rasterises inline when the pool is turned off", async () => {
    const payload = await samplePayload(SECRET, baseOverrides(), CLIP_SECONDS * 1000);
    const outcome = await renderVideo(payload, FIXTURE_IDS.workspaceId, {
      ...dependencies(),
      rasterWorkers: 0,
    });
    expect(outcome.rasterWorkers).toBe(0);
    expect(outcome.sizeBytes).toBeGreaterThan(1_000);
  }, 600_000);
});

describe("the cloud-only output shapes", () => {
  it("writes a ProRes 4444 caption layer with a real alpha channel", async () => {
    // Alpha is cloud-only (`03 F-502`): `VideoEncoderConfig.alpha:"keep"` could
    // not be verified in any browser, so this path has no browser twin.
    const overrides = baseOverrides();
    const payload = await samplePayload(
      SECRET,
      {
        ...overrides,
        caps: {
          maxWidth: 1920,
          maxHeight: 1920,
          maxDurationMs: 20 * 60_000,
          maxFps: 60,
          allowAlpha: true,
        },
        output: {
          kind: "alpha",
          preset: "custom",
          aspect: "9:16",
          width: WIDTH,
          height: HEIGHT,
          fps: FPS,
          container: "mov",
          videoCodec: "prores4444",
        },
        audio: { strategy: "none", codec: "aac", bitrateKbps: 192 },
      },
      CLIP_SECONDS * 1000,
    );
    const outcome = await renderVideo(payload, FIXTURE_IDS.workspaceId, dependencies());
    expect(outcome.outputKey.endsWith(".mov")).toBe(true);

    const probe = await ffprobe(derivedStore.pathFor(outcome.outputKey));
    const video = streams(probe).find((stream) => stream.codec_type === "video") as
      (ProbeStream & { pix_fmt?: string }) | undefined;
    expect(video?.codec_name).toBe("prores");
    // The pixel format is the assertion that matters: `yuva` is the only
    // ProRes flavour that carries alpha at all.
    expect(video?.pix_fmt).toContain("yuva");
    expect(streams(probe).some((stream) => stream.codec_type === "audio")).toBe(false);
  }, 600_000);

  it("writes a green-screen caption layer over a solid chroma ground", async () => {
    const overrides = baseOverrides();
    const payload = await samplePayload(
      SECRET,
      {
        ...overrides,
        output: {
          kind: "greenscreen",
          preset: "custom",
          aspect: "9:16",
          width: WIDTH,
          height: HEIGHT,
          fps: FPS,
          container: "mp4",
          videoCodec: "h264",
          crf: 30,
          encoderPreset: "ultrafast",
          chromaKey: "#00b140",
        },
        audio: { strategy: "none", codec: "aac", bitrateKbps: 192 },
      },
      CLIP_SECONDS * 1000,
    );
    const outcome = await renderVideo(payload, FIXTURE_IDS.workspaceId, dependencies());

    // One pixel from a corner the captions never reach must be the chroma key.
    const frame = join(scratch, "green-frame.raw");
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        "1",
        "-i",
        derivedStore.pathFor(outcome.outputKey),
        "-frames:v",
        "1",
        "-vf",
        "crop=8:8:4:4,scale=1:1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        frame,
      ],
      { timeout: 120_000, windowsHide: true },
    );
    const pixel = await readFile(frame);
    expect(pixel[1]).toBeGreaterThan(120);
    expect(pixel[0]).toBeLessThan(80);
    expect(pixel[2]).toBeLessThan(120);
  }, 600_000);
});

describe("the refusals", () => {
  it("refuses a manifest signed with the wrong key, before touching any media", async () => {
    const payload = await samplePayload("some other secret", baseOverrides(), 2_000);
    const before = derivedStore.written.length;
    let caught: unknown;
    try {
      await renderVideo(payload, FIXTURE_IDS.workspaceId, dependencies());
    } catch (error) {
      caught = error;
    }
    expect(isRenderManifestError(caught, "manifest/bad-signature")).toBe(true);
    expect(derivedStore.written).toHaveLength(before);
  });

  it("refuses a manifest whose watermark was stripped after signing", async () => {
    const signed = signedFixtureManifest(SECRET, {
      ...baseOverrides(),
      watermark: { assetId: "aksharo-mark", position: "bottom-right", opacity: 0.85 },
    });
    const payload = await samplePayload(SECRET, baseOverrides(), 2_000);
    const tampered: RenderVideoPayload = {
      ...payload,
      manifest: { ...signed, watermark: null },
    };
    let caught: unknown;
    try {
      await renderVideo(tampered, FIXTURE_IDS.workspaceId, dependencies());
    } catch (error) {
      caught = error;
    }
    expect(isRenderManifestError(caught, "manifest/bad-signature")).toBe(true);
  });

  it("refuses an expired manifest", async () => {
    const payload = await samplePayload(SECRET, baseOverrides(), 2_000);
    let caught: unknown;
    try {
      await renderVideo(payload, FIXTURE_IDS.workspaceId, {
        ...dependencies(),
        now: () => Date.now() + 4 * 60 * 60_000,
      });
    } catch (error) {
      caught = error;
    }
    expect(isRenderManifestError(caught, "manifest/expired")).toBe(true);
  });

  it("refuses a render that exceeds the workspace's caps, before touching any media", async () => {
    const overrides = baseOverrides();
    const payload = await samplePayload(
      SECRET,
      {
        ...overrides,
        output: {
          kind: "video",
          preset: "youtube-4k",
          aspect: "16:9",
          width: 3840,
          height: 2160,
          fps: 30,
          container: "mp4",
          videoCodec: "h264",
        },
      },
      2_000,
    );
    const before = derivedStore.written.length;
    let caught: unknown;
    try {
      await renderVideo(payload, FIXTURE_IDS.workspaceId, dependencies());
    } catch (error) {
      caught = error;
    }
    expect(isRenderManifestError(caught, "manifest/caps-exceeded")).toBe(true);
    expect(derivedStore.written).toHaveLength(before);
  });

  it("refuses a manifest issued for another workspace", async () => {
    const payload = await samplePayload(SECRET, baseOverrides(), 2_000);
    await expect(
      renderVideo(payload, "01JA20OTHERWS0000000000000", dependencies()),
    ).rejects.toThrow(/but the job is for/);
  });

  it("refuses a manifest that never had a signature at all", async () => {
    const payload = await samplePayload(SECRET, baseOverrides(), 2_000);
    const unsigned = { ...payload, manifest: fixtureManifest(baseOverrides()) };
    let caught: unknown;
    try {
      await renderVideo(unsigned as RenderVideoPayload, FIXTURE_IDS.workspaceId, dependencies());
    } catch (error) {
      caught = error;
    }
    expect(isRenderManifestError(caught, "manifest/malformed")).toBe(true);
  });
});
