/**
 * A19b: the parity check the brief asks for — the browser exporter's own
 * caption-rasterisation path (a persistent `CanvasKitBackend` raster surface,
 * `drawFrame` + `readPixels`, exactly what `engine.ts`'s frame loop does)
 * compared against `@montaj/render-skia-node`'s cloud renderer on the same
 * `DrawCommand[]`, with decision D33's own yardstick
 * (`PARITY_MAX_DIFF_RATIO`/`PARITY_CHANNEL_TOLERANCE`).
 *
 * `@montaj/render-canvaskit`'s own `render-skia-node` parity suite
 * (`packages/render-skia-node/src/parity.test.ts`) already proves
 * `CanvasKitBackend.renderToPng` matches the cloud renderer; what that suite
 * does not prove is that *this package's* pixel-extraction path — raw
 * `readPixels()` off a reused surface, not a PNG round trip — produces the
 * same bytes. PNG is lossless, so the two must agree, but this test measures
 * it rather than asserting it by argument: it calls `CanvasKitBackend`
 * exactly as `engine.ts` does (`MakeSurface` once, `drawFrame`, `flush`,
 * `makeImageSnapshot().readPixels(...)`) and diffs the result against
 * `SkiaNodeBackend.renderFrameToRgba`.
 *
 * Node-only (`@napi-rs/canvas`), so this lives in `apps/web`'s own vitest
 * suite as a devDependency-backed check, never bundled into the browser.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BASELINE_BACKGROUND,
  BASELINE_CANVAS,
  BASELINE_FRAMES,
  CanvasKitBackend,
  loadCanvasKit,
} from "@montaj/render-canvaskit";
import { buildBaselineCommands } from "@montaj/render-canvaskit/testing";
import type { DrawCommand } from "@montaj/render-core";
import { SkiaNodeBackend } from "@montaj/render-skia-node";
import {
  comparePixels,
  createFixtureRenderer,
  loadFixtureFonts,
  PARITY_MAX_DIFF_RATIO,
} from "@montaj/render-skia-node/testing";

import type { CanvasKit } from "canvaskit-wasm";

let ck: CanvasKit;
let backend: CanvasKitBackend;
let cloud: SkiaNodeBackend;
let baselines: Record<string, DrawCommand[]>;

beforeAll(async () => {
  ck = await loadCanvasKit();
  backend = await CanvasKitBackend.create({ canvasKit: ck, fonts: loadFixtureFonts() });
  const renderer = await createFixtureRenderer();
  cloud = await SkiaNodeBackend.create({ shaper: renderer.shaper });
  baselines = await buildBaselineCommands();
}, 120_000);

afterAll(() => {
  backend?.dispose();
  cloud?.dispose();
});

/**
 * `engine.ts`'s own compositing path: a persistent raster surface, `drawFrame`
 * onto it, `flush`, then `readPixels` off the snapshot — no PNG in between.
 */
function readbackPixels(
  commands: readonly DrawCommand[],
  width: number,
  height: number,
  background: string,
): Uint8Array {
  const surface = ck.MakeSurface(width, height);
  if (surface === null) throw new Error("could not allocate a raster surface");
  try {
    const canvas = surface.getCanvas();
    canvas.clear(colourOf(background));
    backend.drawFrame(canvas, commands, {});
    surface.flush();
    const snapshot = surface.makeImageSnapshot();
    try {
      const pixels = snapshot.readPixels(0, 0, {
        width,
        height,
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      });
      if (pixels === null) throw new Error("readPixels returned null");
      return pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer);
    } finally {
      snapshot.delete();
    }
  } finally {
    surface.delete();
  }
}

function colourOf(colour: string): Float32Array {
  const r = Number.parseInt(colour.slice(1, 3), 16) / 255;
  const g = Number.parseInt(colour.slice(3, 5), 16) / 255;
  const b = Number.parseInt(colour.slice(5, 7), 16) / 255;
  const a = colour.length === 9 ? Number.parseInt(colour.slice(7, 9), 16) / 255 : 1;
  return ck.Color4f(r, g, b, a);
}

// The same small-type frames the render-skia-node suite itself budgets above
// the 1% SLO (glyph-edge anti-aliasing, not a defect — see that suite's
// header); everything else holds to D33's own PARITY_MAX_DIFF_RATIO.
const KNOWN_TEXT_RESIDUALS: Readonly<Record<string, number>> = Object.freeze({
  "neon-glow-english": 0.04,
});

describe("A19b: engine.ts's raw readPixels path vs the cloud renderer (D33)", () => {
  it.each(BASELINE_FRAMES.map((frame) => frame.name))(
    "%s matches @montaj/render-skia-node within decision D33's tolerance",
    (name) => {
      const commands = baselines[name] ?? [];
      const expected = readbackPixels(
        commands,
        BASELINE_CANVAS.width,
        BASELINE_CANVAS.height,
        BASELINE_BACKGROUND,
      );
      const actual = cloud.renderFrameToRgba(commands, {
        width: BASELINE_CANVAS.width,
        height: BASELINE_CANVAS.height,
        background: BASELINE_BACKGROUND,
      });
      const diff = comparePixels(expected, actual);
      expect(diff.ratio).toBeLessThanOrEqual(KNOWN_TEXT_RESIDUALS[name] ?? PARITY_MAX_DIFF_RATIO);
    },
    30_000,
  );
});
