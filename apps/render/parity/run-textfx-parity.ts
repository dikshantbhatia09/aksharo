#!/usr/bin/env tsx
/**
 * D06b's text-fx parity gate: measures how much `apps/web/lib/export/
 * engine.ts`'s CanvasKit compositor and this app's own Skia-node rasteriser
 * disagree on the pixels of `renderTitleFrame`'s `DrawCommand[]` — one title
 * per D06 motion preset, sampled at three instants across a 6-second clip
 * (`textfx-fixtures.ts`) — and writes `results.json`'s `titles` block, the
 * same merge-preserving pattern `run.ts` (`edits`) and `run-audio-parity.ts`
 * (`audio`) already use: this script reads the file first and only replaces
 * its own key.
 *
 * Run: `pnpm --filter @montaj/render parity:titles`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CanvasKitBackend, loadCanvasKit } from "@montaj/render-canvaskit";
import { loadFixtureFonts } from "@montaj/render-core/testing";
import { SkiaNodeBackend } from "@montaj/render-skia-node";
import { comparePixels, PARITY_CHANNEL_TOLERANCE } from "@montaj/render-skia-node/testing";

import {
  buildTextFxFrames,
  createTextFxRenderer,
  TEXTFX_CANVAS,
  TEXTFX_PRESET_FIXTURES,
  type TextFxParityFrame,
} from "./textfx-fixtures.js";

import type { CanvasKit } from "canvaskit-wasm";

const RESULTS_PATH = join(__dirname, "results.json");

/**
 * Text glyph edges anti-alias slightly differently between CanvasKit and
 * Skia-node (`apps/web/lib/export/engine-parity.test.ts`'s own
 * `KNOWN_TEXT_RESIDUALS` documents the same residual for captions); a title
 * is drawn bigger and heavier than a caption, so it is held to a slightly
 * wider tolerance than D33's general 1%, not to a stricter one.
 */
export const TEXTFX_MAX_DIFF_RATIO = 0.02;

function browserPixels(
  ck: CanvasKit,
  backend: CanvasKitBackend,
  frame: TextFxParityFrame,
): Uint8Array {
  const surface = ck.MakeSurface(TEXTFX_CANVAS.width, TEXTFX_CANVAS.height);
  if (surface === null) throw new Error("could not allocate a raster surface");
  try {
    const canvas = surface.getCanvas();
    canvas.clear(ck.TRANSPARENT);
    backend.drawFrame(canvas, frame.commands, {});
    surface.flush();
    const snapshot = surface.makeImageSnapshot();
    try {
      const pixels = snapshot.readPixels(0, 0, {
        width: TEXTFX_CANVAS.width,
        height: TEXTFX_CANVAS.height,
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

interface PresetResult {
  readonly preset: string;
  readonly samples: number;
  readonly maxDiffRatio: number;
  readonly pass: boolean;
  readonly measuredAt: string;
}

export async function measureAll(now: string = new Date().toISOString()): Promise<{
  generatedAt: string;
  maxDiffRatioTolerance: number;
  channelTolerance: number;
  canvas: { width: number; height: number };
  presets: Record<string, PresetResult>;
}> {
  const ck = await loadCanvasKit();
  const browserBackend = await CanvasKitBackend.create({
    canvasKit: ck,
    fonts: loadFixtureFonts(),
  });
  const renderer = await createTextFxRenderer();
  const cloudBackend = await SkiaNodeBackend.create({ shaper: renderer.shaper });
  try {
    const frames = buildTextFxFrames(renderer);
    const presets: Record<string, PresetResult> = {};

    for (const fixture of TEXTFX_PRESET_FIXTURES) {
      const framesForPreset = frames.filter((frame) => frame.preset === fixture.preset);
      let maxDiffRatio = 0;
      for (const frame of framesForPreset) {
        const browser = browserPixels(ck, browserBackend, frame);
        const cloud = cloudBackend.renderFrameToRgba(frame.commands, {
          width: TEXTFX_CANVAS.width,
          height: TEXTFX_CANVAS.height,
          background: "#000000ff",
        });
        // The browser surface above is cleared transparent, but a transparent
        // pixel compares fine against `comparePixels`'s per-channel tolerance
        // only when both sides agree on alpha too — draw the cloud frame onto
        // the same transparent ground so the two are compared like for like.
        const browserOnBlack = compositeOverBlack(browser);
        const diff = comparePixels(browserOnBlack, cloud, PARITY_CHANNEL_TOLERANCE);
        maxDiffRatio = Math.max(maxDiffRatio, diff.ratio);
      }
      presets[fixture.preset] = {
        preset: fixture.preset,
        samples: framesForPreset.length,
        maxDiffRatio,
        pass: maxDiffRatio <= TEXTFX_MAX_DIFF_RATIO,
        measuredAt: now,
      };
    }

    return {
      generatedAt: now,
      maxDiffRatioTolerance: TEXTFX_MAX_DIFF_RATIO,
      channelTolerance: PARITY_CHANNEL_TOLERANCE,
      canvas: { width: TEXTFX_CANVAS.width, height: TEXTFX_CANVAS.height },
      presets,
    };
  } finally {
    browserBackend.dispose();
    cloudBackend.dispose();
  }
}

/** Un-premultiplies a transparent-ground CanvasKit readback onto opaque black, matching the cloud frame's own opaque background. */
function compositeOverBlack(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = (rgba[index + 3] ?? 0) / 255;
    out[index] = Math.round((rgba[index] ?? 0) * alpha);
    out[index + 1] = Math.round((rgba[index + 1] ?? 0) * alpha);
    out[index + 2] = Math.round((rgba[index + 2] ?? 0) * alpha);
    out[index + 3] = 255;
  }
  return out;
}

/** The other keys `results.json` may already carry (`edits`, `audio`) — preserved verbatim. */
async function existingResults(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(RESULTS_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const output = await measureAll();
  const merged = { ...(await existingResults()), titles: output };
  await writeFile(RESULTS_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  const failed = Object.values(output.presets).filter((result) => !result.pass);
  for (const result of Object.values(output.presets)) {
    console.error(
      `${result.pass ? "PASS" : "FAIL"} ${result.preset}: max diff ratio ` +
        `${result.maxDiffRatio.toFixed(4)} over ${String(result.samples)} samples ` +
        `(tolerance ${String(TEXTFX_MAX_DIFF_RATIO)})`,
    );
  }
  if (failed.length > 0) {
    console.error(`${String(failed.length)} text-fx parity preset(s) exceeded tolerance.`);
    process.exitCode = 1;
  }
}

// Script entry point — not when `measureAll`/`main` are merely imported by a test.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("parity/run-textfx-parity.ts") === true) {
  void main();
}
