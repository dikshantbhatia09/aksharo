/**
 * The parity harness: the frames the two backends are compared on, and the
 * pixel yardstick decision D33 defines.
 *
 * Two sets of frames, and they catch different things:
 *
 * - **A16's seven baselines** (`@montaj/render-canvaskit`'s `BASELINE_FRAMES`)
 *   are chosen to cover the *command surface* — stroke, shadow, box, karaoke
 *   clip, gradient shader, backdrop blur, raster copies, shadow-only glow. If a
 *   command kind has no frame there, nothing catches a backend that draws it
 *   wrong.
 * - **The four caption fixtures at three instants** cover the *scripts and the
 *   animation clock* — Hinglish font fallback, Devanagari and Tamil shaping,
 *   and the entry/middle/exit phases every style animates through.
 *
 * This module reads the filesystem, so it is never imported from the package's
 * runtime path.
 */

import { loadSystemStyleMap } from "@montaj/caption-styles";
import { animate, layoutSegment, type DrawCommand } from "@montaj/render-core";
import {
  CAPTION_FIXTURES,
  createFixtureRenderer,
  GOLDEN_TIMESTAMPS_MS,
  loadFixtureFonts,
  PROXY_CANVAS,
  type FixtureRenderer,
} from "@montaj/render-core/testing";

export { loadFixtureFonts, createFixtureRenderer, PROXY_CANVAS, GOLDEN_TIMESTAMPS_MS };

/**
 * The parity SLO of decision D33: at most 1% of pixels off by more than 2/255.
 *
 * Deliberately the same two numbers `@montaj/render-canvaskit`'s browser lane
 * uses, and re-declared here rather than imported so this package's gate cannot
 * be loosened by a change somewhere else.
 */
export const PARITY_MAX_DIFF_RATIO = 0.01;
export const PARITY_CHANNEL_TOLERANCE = 2;

export interface PixelDiff {
  /** Pixels whose worst channel differs by more than the tolerance. */
  readonly differing: number;
  readonly total: number;
  /** `differing / total`. */
  readonly ratio: number;
  /** Largest single-channel difference seen, 0–255. */
  readonly maxChannelDelta: number;
}

/** Compares two straight-RGBA buffers with D33's yardstick. */
export function comparePixels(
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
  tolerance = PARITY_CHANNEL_TOLERANCE,
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

/** One (style × caption × instant) triple the parity suite renders. */
export interface ParityFrame {
  readonly name: string;
  readonly styleId: string;
  readonly fixture: string;
  readonly tMs: number;
  readonly commands: DrawCommand[];
}

/**
 * The style the fixture sweep uses.
 *
 * `punch-pop` because it is the busiest style in the catalogue that every
 * script survives: stroked type, a drop shadow and a per-word scale transform,
 * which together exercise the three command kinds most likely to drift between
 * a glyph-drawing backend and an outline-drawing one.
 */
export const PARITY_SWEEP_STYLE = "punch-pop";

/** Ground for the parity renders: opaque, so anti-aliased edges have something to bite on. */
export const PARITY_BACKGROUND = "#1a1a20ff";

/**
 * Four caption fixtures × three instants, built from the same layout the
 * browser backend will be given.
 */
export async function buildParitySweep(
  renderer?: FixtureRenderer,
  styleId: string = PARITY_SWEEP_STYLE,
): Promise<ParityFrame[]> {
  const { registry, shaper } = renderer ?? (await createFixtureRenderer());
  const style = loadSystemStyleMap().get(styleId);
  if (style === undefined) throw new Error(`no such system style: ${styleId}`);

  const frames: ParityFrame[] = [];
  for (const fixture of CAPTION_FIXTURES) {
    for (const tMs of GOLDEN_TIMESTAMPS_MS) {
      const layout = layoutSegment({
        style,
        segment: fixture.segment,
        words: fixture.words,
        canvas: PROXY_CANVAS,
        registry,
        shaper,
        tMs,
      });
      frames.push({
        name: `${styleId}-${fixture.name}-${String(tMs)}`,
        styleId,
        fixture: fixture.name,
        tMs,
        commands: animate({ layout, style, tMs }),
      });
    }
  }
  return frames;
}
