/**
 * The frames the PNG baselines are made from, and the one place that says which
 * (style, caption, instant) triples they are.
 *
 * The set is chosen to cover the command surface rather than to be pretty:
 * stroked and shadowed type, a block box, a karaoke clip, a gradient fill, a
 * backdrop blur, the raster copies, a shadow-only glow, and all three scripts.
 * If a command kind has no frame here, nothing catches a backend that draws it
 * wrong.
 */

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
}

export const BASELINE_FRAMES: readonly BaselineFrame[] = [
  {
    name: "punch-pop-hinglish",
    styleId: "punch-pop",
    fixture: "hinglish",
    tMs: 1500,
    covers: "stroked type, drop shadow, per-word scale transform, Latin + Devanagari in one caption",
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
