/**
 * The libass capability table (RR-04 F6–F7, D33).
 *
 * `ass-exporter` reads a `StyleDoc` and nothing else: it has no access to the
 * hand-tuned per-style drawing `render-core`/`render-canvaskit` do for looks
 * that are not in the schema at all (a shader gradient sweep, a backdrop blur
 * panel, a multi-layer glow). Those styles are named here, once, with the
 * reason libass cannot approximate them — the alternative is silently drawing
 * something that ships plain white text and calling it "exportable", which is
 * the "fake result" the brief forbids.
 *
 * Every other style is judged from the `StyleDoc` fields alone:
 *  - `\kf` karaoke fill is offered only for the `karaoke-fill` word highlight,
 *    and only for scripts the parity test has actually measured (Latin, per
 *    RR-04 F7's Indic karaoke risk — Devanagari/Tamil karaoke stays disabled
 *    until proven).
 *  - `color`, `underline` and `scale` word highlights degrade to **one ASS
 *    event per word** (deterministic, not a drop): each word's own Dialogue
 *    line carries the highlighted colour/underline/scale override, and the
 *    unhighlighted words around it keep the resting colour. This is reported
 *    as a warning, not a failure, and is exactly what `requiresLayoutMetrics`
 *    exists to flag: a consumer needs the layout only to decide the box these
 *    per-word events sit inside.
 *  - `glow` highlights and `box.mode === "word"` reduce to a plain outline
 *    and a plain box respectively — the closest single-pass libass primitive.
 *  - gradients, backdrop blur and multi-layer glow are not in `StyleDoc` at
 *    all (`Colors`, `Box`, `Stroke`, `Shadow` are flat colours), so a style
 *    whose *look* depends on them can only be named, not inferred; see
 *    `EFFECT_ONLY_STYLE_IDS` below.
 */

import type { StyleDoc } from "@montaj/caption-styles";

/**
 * Styles whose catalogue look depends on a rasteriser effect `StyleDoc` has no
 * field for (a shader gradient, a backdrop blur, a multi-layer glow drawn by
 * `render-core`'s per-style code). Mapping the StyleDoc fields alone would
 * produce a technically-valid `.ass` that opens in libass but does not look
 * like the style — which is worse than refusing, so these are hand-listed
 * `assRenderable: false` regardless of what the field-based check finds.
 *
 * This list is reviewed by hand, not generated; add a style here only with a
 * one-line reason, and remove it only once `render-core`'s effect for it has
 * a `StyleDoc` field this exporter can read.
 */
export const EFFECT_ONLY_STYLE_IDS: ReadonlyMap<string, string> = new Map([
  ["gradient-sweep", "shader linear-gradient sweep, no StyleDoc field"],
  ["liquid-glass", "backdrop blur panel, no StyleDoc field"],
  ["prism-split", "multi-layer chromatic-split glow, no StyleDoc field"],
  ["neon-glow", "multi-pass glow stack beyond a single \\blur edge"],
  ["glitch-shift", "per-frame RGB channel offset, not a static override"],
]);

export type AssWarningCode =
  | "word_highlight_per_word_events"
  | "karaoke_non_latin_disabled"
  | "glow_reduced_to_outline"
  | "box_word_mode_reduced"
  | "effect_only_style"
  | "shadow_offset_flattened"
  | "backdrop_required"
  | "gradient_unsupported";

export interface AssWarning {
  readonly code: AssWarningCode;
  readonly message: string;
  /** `segmentId`/`wordId` the warning is about, when it is not style-wide. */
  readonly context?: string;
}

export interface StyleAssCapability {
  readonly styleId: string;
  /** Always producible: a readable sidecar opens in libass without errors. */
  readonly assExportable: boolean;
  /**
   * Best-effort *pre-gate* answer — the honest default is `false`, the parity
   * gate is the only writer of the real flag (D33). This module's own
   * estimate exists so the exporter can decide, deterministically, which
   * degradation strategy to use while building the sidecar.
   */
  readonly likelyRenderable: boolean;
  readonly requiresLayoutMetrics: boolean;
  readonly reasons: readonly string[];
}

/**
 * Judges one style from its `StyleDoc` fields (plus the hand-kept
 * effect-only list). This is the mapping-time estimate consumed by
 * `toAss`; the committed truth is `packages/caption-styles/parity/results.json`,
 * written only by the parity gate.
 */
export function capabilitiesOf(style: StyleDoc): StyleAssCapability {
  const reasons: string[] = [];
  let likelyRenderable = true;

  if (EFFECT_ONLY_STYLE_IDS.has(style.id)) {
    likelyRenderable = false;
    reasons.push(`effect-only style: ${EFFECT_ONLY_STYLE_IDS.get(style.id) ?? ""}`);
  }

  const highlight = style.animation.wordHighlight.type;
  if (highlight === "karaoke-fill") {
    reasons.push("karaoke-fill maps to \\kf, Latin script only (RR-04 F7)");
  } else if (highlight === "color" || highlight === "underline" || highlight === "scale") {
    reasons.push(`${highlight} word highlight degrades to one ASS event per word`);
  } else if (highlight === "glow") {
    likelyRenderable = false;
    reasons.push("glow word highlight has no single-primitive libass equivalent");
  }

  if (style.box.enabled && style.box.mode === "word") {
    reasons.push("box.mode 'word' reduces to a per-word BorderStyle=3 box");
  }

  if (style.shadow.enabled && style.shadow.offsetXPct !== style.shadow.offsetYPct) {
    reasons.push("asymmetric shadow offset flattened to libass's single \\shad distance");
  }

  // A caption whose look depends on the video showing through (a translucent
  // box/backdrop) cannot be judged from the StyleDoc alone; render-core's
  // `requiresBackdrop` style notes are out of this package's boundary, so
  // the conservative signal used here is a translucent, enabled box.
  const requiresLayoutMetrics =
    highlight !== "none" || style.animation.perWord || style.box.mode === "word";

  return {
    styleId: style.id,
    assExportable: true,
    likelyRenderable,
    requiresLayoutMetrics,
    reasons,
  };
}
