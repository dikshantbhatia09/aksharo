/**
 * Line budgets that come from the type, not from a table (decision D78).
 *
 * `09 §3` fixes 32/24/22 characters a line and two lines a caption. Those are
 * **readability caps** — how much a viewer can read in the time the caption is
 * up — and they are maxima, not targets. Whether that many characters actually
 * fit is a different question, answered by the font, the type size, the box
 * width and the canvas:
 *
 * - a budget is counted in **base characters** (combining marks excluded),
 *   because that is what reading speed depends on;
 * - width is counted in **em**, and 22 Tamil characters is about 37 code points
 *   and roughly twice the width of 32 Latin characters;
 * - a 9:16 frame is 1080 px wide and a 16:9 frame 1920, for the same type size.
 *
 * `fitBudget` measures the first and reconciles it with the second, so the
 * segmenter cuts captions the renderer can draw at the size the style asks for.
 * The alternative — shrinking the type until the table's number fits — is what
 * turns a creator caption into a subtitle.
 *
 * The measurement runs a fixed per-script sample through the **real shaper**
 * with the **resolved font**, so the number the segmenter cuts to and the number
 * the layout draws to come from one set of metrics. A11 calls this at EDG
 * initialisation with the project's aspect and default style; A15 offers a
 * reflow (a `Resegment` op) when a style change moves the budget.
 */

import { type StyleDoc } from "@montaj/caption-styles";

import { resolveFontOrThrow } from "../fonts/registry.js";
import { clusterBoundaries, codePointsOf, type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { applyTextTransform } from "../layout/text-transform.js";
import { charCount, limitsFor, scriptScaleFor, type WordScript } from "../script.js";
import {
  assertCanvas,
  type CanvasSize,
  clamp,
  ofCanvasHeight,
  ofCanvasShortSide,
  ofCanvasWidth,
  ofFontSize,
} from "../units.js";

/** Readability cap on lines (`09 §3`); a caption never exceeds it. */
export const READABILITY_MAX_LINES = 2;

/**
 * Below this a caption is barely a caption — one short word a line. It is an
 * **advisory** threshold, surfaced as `belowComfortableMinimum`, never a clamp:
 * raising a budget to a number the box cannot hold would put the overflow back,
 * which is the whole thing D78 removes. A style this large is telling the user
 * something true, and the editor should say so rather than quietly overflow.
 */
export const MIN_BUDGET_CHARS = 8;

/**
 * Width the budget deliberately leaves unspent. The average advance is an
 * average: a line of unusually wide words is wider than `average × count`, and
 * without a little slack a caption cut to exactly the budget would shrink by a
 * percent or two — which is the thing this whole mechanism exists to avoid.
 */
const SAFETY = 0.9;

/**
 * The sample each script's average advance is measured from. Fixed and
 * committed, because the number it produces reaches the segmenter's output: a
 * sample that changed would resegment every project in the fleet.
 *
 * Spaces are included on purpose, so the average carries the inter-word gap and
 * a caller never has to model it separately.
 */
export const BUDGET_SAMPLES: Readonly<Record<WordScript, string>> = {
  latin: "the quick brown fox jumps over a lazy dog and then edits video captions",
  devanagari: "आज हम वीडियो एडिटिंग के बारे में बात करेंगे और ट्रांसक्रिप्ट भी देखेंगे",
  tamil: "இன்று நாம் வீடியோ எடிட்டிங் பற்றி பேசுவோம் மற்றும் வசனங்களையும் பார்ப்போம்",
  other: "the quick brown fox jumps over a lazy dog and then edits video captions",
};

export interface FitBudgetOptions {
  readonly style: StyleDoc;
  readonly script: WordScript;
  readonly canvas: CanvasSize;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
}

export interface LineBudget {
  /** Characters a line may hold: `min(readability cap, what fits)`. */
  readonly maxChars: number;
  /** Lines a caption may hold: `min(2, the style's own, what fits)`. */
  readonly maxLines: number;
  /** The `09 §3` cap, so a caller can say why the budget is what it is. */
  readonly readabilityMaxChars: number;
  /** What the metrics alone would allow, before the cap. */
  readonly fitMaxChars: number;
  /** Measured average advance per base character, in em. */
  readonly avgAdvanceEm: number;
  /** Type size the measurement assumed, in canvas pixels. */
  readonly fontSizePx: number;
  /** Width a line may occupy, after box padding and the safe area. */
  readonly availableWidthPx: number;
  /** `true` when the metrics, not readability, decided the budget. */
  readonly limitedByFit: boolean;
  /**
   * `true` when the budget is below `MIN_BUDGET_CHARS` — the style is large
   * enough that captions will be one short word a line. Advisory: the budget is
   * still honoured, because it is what actually fits.
   */
  readonly belowComfortableMinimum: boolean;
}

/**
 * Average advance per **base character** of one script in one style's face, in
 * em. Measured through the real shaper, so ligatures, matra reordering and
 * cluster-level letter spacing are all inside the number, and through the same
 * font resolution the layout will use, so the two cannot disagree.
 */
export function averageAdvanceEm(options: Omit<FitBudgetOptions, "canvas">): number {
  const { style, script, registry, shaper } = options;
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const sample = applyTextTransform(BUDGET_SAMPLES[script], style.typography.textTransform);
  const font = resolveFontOrThrow(
    registry,
    {
      family: style.typography.fontFamily,
      fallbacks: style.typography.fallbacks,
      weight: style.typography.weight,
      italic: style.typography.italic,
      script,
    },
    codePointsOf(sample),
  );
  const run = shaper.shape({ text: sample, fontId: font.id, script });
  const clusters = clusterBoundaries(run).length;
  const advanceEm =
    run.advance / run.upem + style.typography.letterSpacingEm * Math.max(0, clusters - 1);
  const characters = charCount(sample);
  return characters === 0 ? 0 : advanceEm / characters;
}

/**
 * The line budget for one (style, script, canvas): `maxChars` is
 * `min(readabilityCap, fitCap)` and `maxLines` is `min(2, the style's, fitCap)`.
 */
export function fitBudget(options: FitBudgetOptions): LineBudget {
  const { style, script, canvas } = options;
  assertCanvas(canvas);

  const readabilityMaxChars = limitsFor(script).maxCharsPerLine;
  const fontSizePx =
    ofCanvasHeight(style.typography.sizePct, canvas) *
    scriptScaleFor(style.typography.scriptScale, script);
  const avgAdvanceEm = averageAdvanceEm(options);

  const safeMarginPx = ofCanvasShortSide(style.layout.safeAreaPct ?? 0, canvas);
  const paddingPx = style.box.enabled ? ofFontSize(style.box.paddingPct, fontSizePx) : 0;

  // The narrower of the style's own box and the safe area, less the box padding
  // on both sides — the same rectangle `layoutSegment` has to fit the type into.
  const availableWidthPx = Math.max(
    0,
    Math.min(ofCanvasWidth(style.layout.maxWidthPct, canvas), canvas.width - 2 * safeMarginPx) -
      2 * paddingPx,
  );
  const perCharacterPx = avgAdvanceEm * fontSizePx;
  const fitMaxChars =
    perCharacterPx <= 0
      ? readabilityMaxChars
      : Math.floor((availableWidthPx * SAFETY) / perCharacterPx);

  const availableHeightPx = Math.max(0, canvas.height - 2 * safeMarginPx - 2 * paddingPx);
  const lineHeightPx = fontSizePx * style.typography.lineHeight;
  const fitMaxLines =
    lineHeightPx <= 0 ? READABILITY_MAX_LINES : Math.floor(availableHeightPx / lineHeightPx);

  // `min(readabilityCap, fitCap)`, floored only at 1: a budget of zero is not a
  // number of characters, and anything above 1 is honoured exactly as measured.
  const maxChars = clamp(Math.min(readabilityMaxChars, fitMaxChars), 1, readabilityMaxChars);

  return {
    maxChars,
    maxLines: clamp(
      Math.min(READABILITY_MAX_LINES, style.layout.maxLines, fitMaxLines),
      1,
      READABILITY_MAX_LINES,
    ),
    readabilityMaxChars,
    fitMaxChars,
    avgAdvanceEm,
    fontSizePx,
    availableWidthPx,
    limitedByFit: fitMaxChars < readabilityMaxChars,
    belowComfortableMinimum: maxChars < MIN_BUDGET_CHARS,
  };
}

/**
 * Every script's budget in one call, in the shape `@montaj/edg/segmenter` takes
 * as `maxCharsByScript`. `maxLines` is the tightest across the scripts, because
 * one caption track has one line count.
 */
export function fitBudgetsByScript(
  options: Omit<FitBudgetOptions, "script">,
  scripts: readonly WordScript[] = ["latin", "devanagari", "tamil", "other"],
): { maxCharsByScript: Record<string, number>; maxLines: number } {
  const maxCharsByScript: Record<string, number> = {};
  let maxLines = READABILITY_MAX_LINES;
  for (const script of scripts) {
    const budget = fitBudget({ ...options, script });
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    maxCharsByScript[script] = budget.maxChars;
    maxLines = Math.min(maxLines, budget.maxLines);
  }
  return { maxCharsByScript, maxLines };
}
