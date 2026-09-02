/**
 * The rasteriser pool and the pooled frame source.
 *
 * The assertion that matters most is the first one: **the pooled path draws the
 * same bytes as the inline path**. Everything else here — slot recycling,
 * ordering, the reference counting — exists to make that true, and a real
 * regression in any of it shows up as a frame that is subtly, silently wrong.
 * When the watermark first reached the workers it did not, and only a byte
 * comparison found it.
 */

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";
import { createHarfBuzzShaper } from "@montaj/render-core";
import type { DrawCommand } from "@montaj/render-core";
import { RenderManifestSchema } from "@montaj/render-manifest";
import { signedFixtureManifest } from "@montaj/render-manifest/testing";
import { SkiaNodeBackend } from "@montaj/render-skia-node";
import { buildTimeMap } from "@montaj/timemap";

import { loadFonts } from "./fonts.js";
import { createFrameSource, createPooledFrameSource, frameTimeMs } from "./frames.js";
import {
  createRasterPool,
  defaultPoolSize,
  MAX_RASTER_WORKERS,
  RasterPoolError,
  resolveWorkerPath,
  SLOTS_PER_WORKER,
  type RasterPool,
} from "./pool.js";
import { toEdgProjection } from "./projection.js";
import { watermarkCommandFor } from "./watermark.js";
import { makeWatermarkPng, sampleProjection } from "../testing.js";

const SECRET = "pool-test-secret";
/** Small on purpose: this suite is about bytes and bookkeeping, not throughput. */
const WIDTH = 180;
const HEIGHT = 320;
const FPS = 10;
const FRAMES = 40;

let openPools: RasterPool[] = [];

afterEach(async () => {
  await Promise.all(openPools.map((pool) => pool.terminate()));
  openPools = [];
});

async function track(pool: Promise<RasterPool>): Promise<RasterPool> {
  const resolved = await pool;
  openPools.push(resolved);
  return resolved;
}

async function commandOptions(watermark: DrawCommand | null = null) {
  const { registry, fonts } = await loadFonts();
  const shaper = await createHarfBuzzShaper(registry);
  const manifest = RenderManifestSchema.parse(
    signedFixtureManifest(
      SECRET,
      {
        output: {
          kind: "video",
          preset: "custom",
          aspect: "9:16",
          width: WIDTH,
          height: HEIGHT,
          fps: FPS,
          container: "mp4",
          videoCodec: "h264",
        },
      },
      Date.now(),
    ),
  );
  return {
    fonts,
    shaper,
    options: {
      projection: toEdgProjection(await sampleProjection(10_000), manifest),
      timemap: buildTimeMap({ sourceDurationMs: 10_000, edits: [] }),
      catalogue: loadSystemStyleMap(),
      registry,
      shaper,
      fps: FPS,
      watermark,
    },
  };
}

describe("pool sizing", () => {
  it("is min(cores − 1, 4), and never zero", () => {
    // One core is left for the thread feeding ffmpeg; past four the encoder is
    // the bottleneck and a fifth worker only takes a core x264 wanted.
    expect(defaultPoolSize(12)).toBe(MAX_RASTER_WORKERS);
    expect(defaultPoolSize(5)).toBe(4);
    expect(defaultPoolSize(3)).toBe(2);
    expect(defaultPoolSize(2)).toBe(1);
    expect(defaultPoolSize(1)).toBe(1);
    expect(defaultPoolSize(0)).toBe(1);
  });

  it("gives every worker a slot to draw into and one to be written from", () => {
    expect(SLOTS_PER_WORKER).toBe(2);
  });

  it("resolves the worker entry from a path that survives the build", () => {
    // `src/render/` and `dist/render/` are both two below the package root.
    expect(resolveWorkerPath().replace(/\\/g, "/")).toMatch(/workers\/raster-worker\.mjs$/);
  });
});

describe("the pool", () => {
  it("refuses to start when the worker entry is missing, so the caller can fall back", async () => {
    await expect(
      createRasterPool({
        width: 16,
        height: 16,
        fonts: [],
        size: 1,
        workerPath: join(__dirname, "no-such-worker.mjs"),
      }),
    ).rejects.toThrow(RasterPoolError);
  });

  it("bounds its memory by the slot count, not the frame count", async () => {
    const { fonts } = await commandOptions();
    const pool = await track(
      createRasterPool({ width: WIDTH, height: HEIGHT, fonts, size: 1, slots: 3 }),
    );
    expect(pool.size).toBe(1);
    expect(pool.slots).toBe(3);
    expect(pool.free).toBe(3);
  }, 120_000);

  it("hands a slot back only when it is released, and reuses it afterwards", async () => {
    const { fonts, options } = await commandOptions();
    const pool = await track(
      createRasterPool({ width: WIDTH, height: HEIGHT, fonts, size: 1, slots: 2 }),
    );
    const inline = createFrameSource({
      ...options,
      backend: await SkiaNodeBackend.create({ shaper: options.shaper }),
      batch: (await SkiaNodeBackend.create({ shaper: options.shaper })).createBatch({
        width: WIDTH,
        height: HEIGHT,
      }),
    });
    const commands = inline.commandsAt(frameTimeMs(0, FPS));

    const first = await pool.render(commands);
    expect(pool.free).toBe(1);
    const second = await pool.render(commands);
    expect(pool.free).toBe(0);
    expect(second.slot).not.toBe(first.slot);

    // A third render has nowhere to go until a slot comes back.
    let third: { slot: number } | null = null;
    void pool.render(commands).then((frame) => (third = frame));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(third).toBeNull();

    pool.release(first);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(third).not.toBeNull();
  }, 120_000);

  it("reports a frame it could not draw rather than answering with stale pixels", async () => {
    const { fonts } = await commandOptions();
    const pool = await track(
      createRasterPool({ width: WIDTH, height: HEIGHT, fonts, size: 1, slots: 2 }),
    );
    await expect(pool.render([{ kind: "nonsense" } as unknown as DrawCommand])).rejects.toThrow(
      /could not be rasterised/,
    );
    // The slot came back, so the render can carry on failing cleanly.
    expect(pool.free).toBe(2);
  }, 120_000);

  it("refuses work once it is closed", async () => {
    const { fonts } = await commandOptions();
    const pool = await createRasterPool({
      width: WIDTH,
      height: HEIGHT,
      fonts,
      size: 1,
      slots: 1,
    });
    await pool.terminate();
    await expect(pool.render([])).rejects.toThrow(/closed/);
  }, 120_000);
});

describe("the pooled frame source against the inline one", () => {
  /** Renders every frame both ways and compares the bytes. */
  async function compare(watermark: DrawCommand | null): Promise<{
    identical: number;
    differing: number[];
    inlineStats: { rasterised: number; reused: number };
    pooledStats: { rasterised: number; reused: number };
  }> {
    const { fonts, options } = await commandOptions(watermark);

    const backend = await SkiaNodeBackend.create({ shaper: options.shaper });
    const images: { assetId: string; bytes: Uint8Array }[] = [];
    if (watermark !== null && watermark.kind === "image") {
      const bytes = await makeWatermarkPng(
        join(__dirname, "..", "..", "coverage", "pool-mark.png"),
      );
      images.push({ assetId: watermark.assetId, bytes });
      await backend.registerImage(watermark.assetId, bytes);
    }
    const inline = createFrameSource({
      ...options,
      backend,
      batch: backend.createBatch({ width: WIDTH, height: HEIGHT }),
    });

    const pool = await track(
      createRasterPool({ width: WIDTH, height: HEIGHT, fonts, images, size: 2, slots: 4 }),
    );
    const pooled = createPooledFrameSource({ ...options, pool, frames: FRAMES });

    const differing: number[] = [];
    let identical = 0;
    for (let index = 0; index < FRAMES; index += 1) {
      const fromPool = Uint8Array.from(await pooled.frame(index));
      // The inline source is synchronous; awaiting it costs nothing and keeps
      // both halves of the comparison typed the same way.
      const fromInline = await inline.frame(index);
      let same = fromPool.length === fromInline.length;
      if (same) {
        for (let byte = 0; byte < fromPool.length; byte += 1) {
          if (fromPool[byte] !== fromInline[byte]) {
            same = false;
            break;
          }
        }
      }
      if (same) identical += 1;
      else differing.push(index);
      pooled.consumed?.(index);
    }
    await pooled.close();
    return {
      identical,
      differing,
      inlineStats: inline.stats,
      pooledStats: pooled.stats,
    };
  }

  it("draws byte-identical frames", async () => {
    const result = await compare(null);
    expect(result.differing).toEqual([]);
    expect(result.identical).toBe(FRAMES);
    // And it makes the same cache decisions, or the comparison above would be
    // comparing two different amounts of work.
    expect(result.pooledStats.rasterised).toBe(result.inlineStats.rasterised);
    expect(result.pooledStats.reused).toBe(result.inlineStats.reused);
    expect(result.pooledStats.rasterised).toBeLessThan(FRAMES);
  }, 300_000);

  it("draws the watermark too, which needs the image bytes on every thread", async () => {
    // The bug this catches: workers with no image table drew every frame
    // correctly except the one thing the plan charges for, and reported
    // nothing.
    const watermark = watermarkCommandFor(
      { assetId: "pool-mark", position: "bottom-right", opacity: 0.9 },
      { width: WIDTH, height: HEIGHT },
    );
    expect(watermark).not.toBeNull();
    const result = await compare(watermark);
    expect(result.differing).toEqual([]);
  }, 300_000);
});
