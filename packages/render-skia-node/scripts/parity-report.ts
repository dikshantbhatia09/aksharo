/**
 * Prints the parity table: every baseline frame and every fixture instant,
 * CanvasKit versus Skia-in-Node, against decision D33's SLO.
 *
 *   pnpm --filter @montaj/render-skia-node parity
 *
 * The test suite asserts these numbers; this script is what you run when one of
 * them moves and you want to see the whole picture rather than the first
 * failure.
 */

import {
  BASELINE_BACKGROUND,
  BASELINE_CANVAS,
  BASELINE_FRAMES,
  CanvasKitBackend,
  loadCanvasKit,
} from "@montaj/render-canvaskit";
import { buildBaselineCommands } from "@montaj/render-canvaskit/testing";
import type { DrawCommand } from "@montaj/render-core";

import { SkiaNodeBackend } from "../src/backend.js";
import {
  buildParitySweep,
  comparePixels,
  createFixtureRenderer,
  loadFixtureFonts,
  PARITY_BACKGROUND,
  PARITY_MAX_DIFF_RATIO,
  PROXY_CANVAS,
} from "../src/testing.js";

import type { CanvasKit } from "canvaskit-wasm";

function decode(ck: CanvasKit, bytes: Uint8Array): Uint8Array {
  const image = ck.MakeImageFromEncoded(bytes);
  if (image === null) throw new Error("could not decode a PNG");
  try {
    const pixels = image.readPixels(0, 0, {
      width: image.width(),
      height: image.height(),
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    });
    if (pixels === null) throw new Error("could not read the decoded PNG");
    return pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer);
  } finally {
    image.delete();
  }
}

async function main(): Promise<void> {
  const ck = await loadCanvasKit();
  const fonts = loadFixtureFonts();
  const browser = await CanvasKitBackend.create({ canvasKit: ck, fonts });
  const renderer = await createFixtureRenderer();
  const cloud = await SkiaNodeBackend.create({ shaper: renderer.shaper });

  const rows: { name: string; ratio: number; max: number; ok: boolean }[] = [];

  const compare = (
    name: string,
    commands: DrawCommand[],
    width: number,
    height: number,
    background: string,
  ): void => {
    const expected = decode(ck, browser.renderToPng(commands, { width, height, background }));
    const actual = cloud.renderFrameToRgba(commands, { width, height, background });
    const diff = comparePixels(expected, actual);
    rows.push({
      name,
      ratio: diff.ratio,
      max: diff.maxChannelDelta,
      ok: diff.ratio <= PARITY_MAX_DIFF_RATIO,
    });
  };

  const baselines = await buildBaselineCommands();
  for (const frame of BASELINE_FRAMES) {
    compare(
      frame.name,
      baselines[frame.name] ?? [],
      BASELINE_CANVAS.width,
      BASELINE_CANVAS.height,
      BASELINE_BACKGROUND,
    );
  }

  for (const frame of await buildParitySweep(renderer)) {
    compare(frame.name, frame.commands, PROXY_CANVAS.width, PROXY_CANVAS.height, PARITY_BACKGROUND);
  }

  const width = Math.max(...rows.map((row) => row.name.length));
  console.log(`${"frame".padEnd(width)}  differing%   maxΔ  verdict`);
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(width)}  ${(row.ratio * 100).toFixed(4).padStart(9)}%  ${String(row.max).padStart(5)}  ${row.ok ? "pass" : "FAIL"}`,
    );
  }
  const failures = rows.filter((row) => !row.ok);
  console.log(
    `\n${String(rows.length - failures.length)}/${String(rows.length)} frames within the D33 SLO (≤ ${String(PARITY_MAX_DIFF_RATIO * 100)}% of pixels off by > 2/255)`,
  );
  browser.dispose();
  cloud.dispose();
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
