/**
 * The frames the PNG baselines are made from, and the one place that says which
 * (style, caption, instant) triples they are.
 *
 * The set is chosen to cover the command surface rather than to be pretty:
 * stroked and shadowed type, a block box, a karaoke clip, a gradient fill, a
 * backdrop blur, the raster copies, a shadow-only glow, and all three scripts.
 * If a command kind has no frame here, nothing catches a backend that draws it
 * wrong.
 *
 * A frame may also lay a **ground** down first. A flat ground hides anything a
 * backend does wrong *outside* what it was asked to touch — which is exactly how
 * a backdrop blur that fogged the whole frame passed this suite until A20 found
 * it. `liquid-glass-hard-edge` puts a hard edge under the panel so that mistake
 * moves pixels.
 */

import type { DrawCommand } from "@montaj/render-core";

/** Canvas the baselines are rendered at: the 540p proxy the editor previews on. */
export const BASELINE_CANVAS = { width: 540, height: 960 } as const;

/** Opaque ground, so anti-aliased edges and the backdrop blur have something to bite on. */
export const BASELINE_BACKGROUND = "#1a1a20ff";

export interface BaselineFrame {
  /** File name of the PNG, without the extension. */
  readonly name: string;
  readonly styleId: string;
  /** A fixture name from `@montaj/render-core/testing`. */
  readonly fixture: string;
  readonly tMs: number;
  /** What this frame is here to catch. */
  readonly covers: string;
  /**
   * Commands drawn **before** the caption, standing in for the video frame a
   * caption is composited over. Needed by anything that samples the surface: on
   * a flat ground a backdrop blur that leaks outside its bounds is invisible.
   */
  readonly ground?: readonly DrawCommand[];
}

/**
 * A hard horizontal edge across the whole frame, placed so it runs **through**
 * the caption panel.
 *
 * That position is the point. Inside the panel the edge must be blurred, which
 * proves the backdrop filter ran at all; outside it the edge must stay razor
 * hard, which proves the filter was clipped. One frame therefore fails both
 * ways — a backdrop that does nothing and a backdrop that fogs the frame — and a
 * σ-wide band of pixels moves either way, so neither can hide.
 */
/** Chosen to fall inside `liquid-glass`'s panel at this canvas size. */
export const HARD_EDGE_Y = 700;

export const HARD_EDGE_GROUND: readonly DrawCommand[] = [
  {
    kind: "rect",
    rect: [0, 0, BASELINE_CANVAS.width, HARD_EDGE_Y],
    fill: { paint: { type: "solid", color: "#ff8800ff" } },
  },
  {
    kind: "rect",
    rect: [0, HARD_EDGE_Y, BASELINE_CANVAS.width, BASELINE_CANVAS.height],
    fill: { paint: { type: "solid", color: "#0b3b6fff" } },
  },
];

export const BASELINE_FRAMES: readonly BaselineFrame[] = [
  {
    name: "liquid-glass-hard-edge",
    styleId: "liquid-glass",
    fixture: "english",
    tMs: 1500,
    ground: HARD_EDGE_GROUND,
    covers: "backdrop blur clipped to its bounds: the hard edge outside the panel must stay hard",
  },
  {
    name: "punch-pop-hinglish",
    styleId: "punch-pop",
    fixture: "hinglish",
    tMs: 1500,
    covers:
      "stroked type, drop shadow, per-word scale transform, Latin + Devanagari in one caption",
  },
  {
    name: "karaoke-fill-hindi",
    styleId: "karaoke-fill",
    fixture: "hindi",
    tMs: 1500,
    covers: "block round-rect box, karaoke sweep clip, Devanagari shaping",
  },
  {
    name: "vertical-clean-tamil",
    styleId: "vertical-clean",
    fixture: "tamil",
    tMs: 1500,
    covers: "plain fill, Tamil shaping and shrink-to-fit",
  },
  {
    name: "prism-split-english",
    styleId: "prism-split",
    fixture: "english",
    tMs: 1500,
    covers: "linear gradient shader on the glyphs",
  },
  {
    name: "liquid-glass-english",
    styleId: "liquid-glass",
    fixture: "english",
    tMs: 1500,
    covers: "backdrop blur layer over the ground",
  },
  {
    name: "glitch-shift-hinglish",
    styleId: "glitch-shift",
    fixture: "hinglish",
    tMs: 1500,
    covers: "offset raster copies inside group layers with opacity",
  },
  {
    name: "neon-glow-english",
    styleId: "neon-glow",
    fixture: "english",
    tMs: 1600,
    covers: "shadow-only glow layer around the word being spoken",
  },
];
