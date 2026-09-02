/**
 * Helpers shared by the Node tests, the PNG baseline builder and the browser
 * e2e test: the command lists for the baseline frames, and a pixel comparison
 * that speaks decision D33's parity SLO.
 *
 * Reads the filesystem, so it never gets imported from the package's runtime.
 */

import { loadSystemStyleMap } from "@montaj/caption-styles";
import { animate, type DrawCommand, layoutSegment } from "@montaj/render-core";
import {
  CAPTION_FIXTURES,
  createFixtureRenderer,
  loadFixtureFonts,
} from "@montaj/render-core/testing";

import { BASELINE_CANVAS, BASELINE_FRAMES } from "./frames.js";

export { loadFixtureFonts };

/** The command list for one named baseline frame. */
export async function buildBaselineCommands(): Promise<Record<string, DrawCommand[]>> {
  const { registry, shaper } = await createFixtureRenderer();
  const styles = loadSystemStyleMap();
  const built: Record<string, DrawCommand[]> = {};

  for (const frame of BASELINE_FRAMES) {
    const style = styles.get(frame.styleId);
    const fixture = CAPTION_FIXTURES.find((entry) => entry.name === frame.fixture);
    if (style === undefined || fixture === undefined) {
      throw new Error(`baseline frame "${frame.name}" names an input that does not exist`);
    }
    const layout = layoutSegment({
      style,
      segment: fixture.segment,
      words: fixture.words,
      canvas: BASELINE_CANVAS,
      registry,
      shaper,
      tMs: frame.tMs,
    });
    built[frame.name] = [...(frame.ground ?? []), ...animate({ layout, style, tMs: frame.tMs })];
  }
  return built;
}

export interface PixelDiff {
  /** Pixels whose worst channel differs by more than the tolerance. */
  readonly differing: number;
  readonly total: number;
  /** `differing / total`. */
  readonly ratio: number;
  /** Largest single-channel difference seen, 0–255. */
  readonly maxChannelDelta: number;
}

/**
 * Compares two RGBA buffers with decision D33's own yardstick: a pixel counts as
 * different when any channel is more than `tolerance` (default 2/255) apart, and
 * the gate is that at most 1% of pixels differ.
 */
export function comparePixels(
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
  tolerance = 2,
): PixelDiff {
  if (a.length !== b.length) {
    throw new Error(`cannot compare buffers of ${String(a.length)} and ${String(b.length)} bytes`);
  }
  let differing = 0;
  let maxChannelDelta = 0;
  for (let index = 0; index < a.length; index += 4) {
    let worst = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs((a[index + channel] ?? 0) - (b[index + channel] ?? 0));
      if (delta > worst) worst = delta;
    }
    if (worst > maxChannelDelta) maxChannelDelta = worst;
    if (worst > tolerance) differing += 1;
  }
  const total = a.length / 4;
  return { differing, total, ratio: total === 0 ? 0 : differing / total, maxChannelDelta };
}

/** The parity SLO from D33: at most 1% of pixels off by more than 2/255. */
export const PARITY_MAX_DIFF_RATIO = 0.01;
