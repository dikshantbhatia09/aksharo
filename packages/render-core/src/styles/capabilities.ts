/**
 * Per-style capability notes.
 *
 * StyleDoc v2 describes type, colour, box, stroke, shadow, layout and
 * animation — enough for 26 of the 30 system styles. Four of them need a
 * drawing capability the schema has no field for: a gradient fill, a sampled
 * backdrop blur, or a raster effect built from several offset passes. Rather
 * than widen a frozen schema (that would be an ADR, not a work package), the
 * extra ink lives here, next to the code that draws it, keyed by style id.
 *
 * `capabilitiesOf` is also what a caller checks before rendering onto a
 * transparent overlay: a `backdrop` style samples the video frame behind it, so
 * it only looks right when the backend composites over the video (CanvasKit on
 * the preview surface, `@napi-rs/canvas` over the decoded frame) and degrades
 * to a flat translucent panel otherwise.
 */

export interface StyleCapabilities {
  /** Samples the pixels behind the caption (`blur` with `backdrop: true`). */
  readonly backdrop: boolean;
  /** Fills type or box with a gradient rather than a flat colour. */
  readonly gradient: boolean;
  /** Needs offset/duplicated passes: RGB split, tape warble, pixel grid. */
  readonly raster: boolean;
  /** Human note for the style catalogue and the parity report. */
  readonly note?: string;
}

const NONE: StyleCapabilities = { backdrop: false, gradient: false, raster: false };

/**
 * Gradient stops for the styles that need them, as offsets on the caption box's
 * width. Kept beside the capability so a style's whole "extra ink" is one entry.
 */
export interface GradientLook {
  readonly stops: readonly { readonly offset: number; readonly color: string }[];
  /** `text` paints the glyphs, `box` paints the panel behind them. */
  readonly target: "text" | "box";
  /** Degrees clockwise from the +x axis. */
  readonly angleDeg: number;
}

const CAPABILITIES: Readonly<Record<string, StyleCapabilities>> = {
  "prism-split": {
    backdrop: false,
    gradient: true,
    raster: false,
    note: "multi-stop gradient across the type; ASS has no gradient fill (RR-04)",
  },
  "gradient-sweep": {
    backdrop: false,
    gradient: true,
    raster: false,
    note: "gradient sweeps the highlight box, not the type",
  },
  "liquid-glass": {
    backdrop: true,
    gradient: false,
    raster: false,
    note: "backdrop blur of the video behind the panel; needs the backend to composite over the frame",
  },
  "glitch-shift": {
    backdrop: false,
    gradient: false,
    raster: true,
    note: "RGB split drawn as two offset copies plus the base; deterministic offsets from tMs",
  },
  "tape-retro": {
    backdrop: false,
    gradient: false,
    raster: true,
    note: "chroma warble drawn as offset copies; no noise source, so it stays reproducible",
  },
};

const GRADIENTS: Readonly<Record<string, GradientLook>> = {
  "prism-split": {
    target: "text",
    angleDeg: 12,
    stops: [
      { offset: 0, color: "#ff2e63" },
      { offset: 0.5, color: "#ffd400" },
      { offset: 1, color: "#3fa7d6" },
    ],
  },
  "gradient-sweep": {
    target: "box",
    angleDeg: 0,
    stops: [
      { offset: 0, color: "#7b2ff7" },
      { offset: 1, color: "#f107a3" },
    ],
  },
};

/** Capabilities of one style; a style with no entry needs nothing extra. */
export function capabilitiesOf(styleId: string): StyleCapabilities {
  return CAPABILITIES[styleId] ?? NONE;
}

/** The gradient a style paints with, when it has one. */
export function gradientOf(styleId: string): GradientLook | undefined {
  return GRADIENTS[styleId];
}

/** Every style with a capability note, for the catalogue and the parity report. */
export function stylesWithCapabilities(): readonly (StyleCapabilities & { readonly id: string })[] {
  return Object.entries(CAPABILITIES)
    .map(([id, capability]) => ({ id, ...capability }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
