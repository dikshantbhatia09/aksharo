/**
 * The fit probe: how much a style has to shrink to get a full caption inside
 * its box.
 *
 * `shrink < 1` means the style's own type size does not agree with the
 * segmenter's character budget — the caption is drawn smaller than the document
 * asks for, so the picker's tile and the burned-in frame disagree. This module
 * is the shared definition of "worst case" used by `tune-style-sizes.ts`, which
 * fixes it, and by `style-fit.test.ts`, which keeps it fixed.
 */

import { type StyleDoc } from "@montaj/caption-styles";

import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { layoutSegment } from "../layout/layout.js";
import { type RenderWord } from "../layout/types.js";
import { charCount, limitsFor, type WordScript } from "../script.js";
import { fitBudget } from "./budget.js";
import { type CanvasSize } from "../units.js";

/** The master canvas the catalogue is authored against. */
export const PORTRAIT_CANVAS: CanvasSize = { width: 1080, height: 1920 };

/** The landscape canvas the same document has to survive. */
export const LANDSCAPE_CANVAS: CanvasSize = { width: 1920, height: 1080 };

/** No caption may shrink below this at the portrait master. */
export const PORTRAIT_MIN_SHRINK = 0.95;

/** Landscape is wider per unit of height, but the floor is still explicit. */
export const LANDSCAPE_MIN_SHRINK = 0.9;

/**
 * Ordinary words, not a stress test. A budget-filling line of capital Ms would
 * force every style down to a size nobody would ship; these are the kind of
 * words the segmenter actually cuts.
 */
const WORD_POOL: Readonly<Record<WordScript, readonly string[]>> = {
  latin: [
    "editing",
    "transcript",
    "brother",
    "simple",
    "caption",
    "video",
    "today",
    "learn",
    "cut",
    "now",
  ],
  devanagari: [
    "ट्रांसक्रिप्ट",
    "मुश्किल",
    "करेंगे",
    "बारे",
    "पहले",
    "आसान",
    "देखो",
    "बहुत",
    "अब",
    "लो",
  ],
  tamil: [
    "எடிட்டிங்",
    "வீடியோ",
    "பேசுவோம்",
    "இன்று",
    "பற்றி",
    "நாம்",
    "வசனங்கள்",
    "இப்படி",
    "இது",
    "நல்ல",
  ],
  other: [
    "editing",
    "transcript",
    "brother",
    "simple",
    "caption",
    "video",
    "today",
    "learn",
    "cut",
    "now",
  ],
};

/**
 * A caption that fills `maxLines` lines to the script's character budget — the
 * worst case the segmenter is allowed to hand the renderer.
 */
export function budgetFillingWords(
  script: WordScript,
  maxLines: number,
  durationMs = 3000,
  maxChars?: number,
): RenderWord[] {
  const budget = maxChars ?? limitsFor(script).maxCharsPerLine;
  // A word longer than the whole budget could never appear in a caption the
  // segmenter cut to it, so it must not appear in the probe either — otherwise
  // the probe measures a caption the product cannot produce.
  const fitting = WORD_POOL[script].filter((word) => charCount(word) <= budget);
  const pool = fitting.length > 0 ? fitting : WORD_POOL[script];
  const texts: string[] = [];
  let lines = 1;
  let lineChars = 0;

  for (let index = 0; lines <= maxLines; index += 1) {
    const word = pool[index % pool.length];
    if (word === undefined) break;
    const chars = charCount(word);
    const fits = texts.length === 0 || lineChars + 1 + chars <= budget;
    if (!fits) {
      if (lines === maxLines) break;
      lines += 1;
      lineChars = chars;
    } else {
      lineChars = texts.length === 0 ? chars : lineChars + 1 + chars;
    }
    texts.push(word);
    if (texts.length > 64) break;
  }

  const span = durationMs / texts.length;
  return texts.map((t, index) => ({
    wid: `probe:${String(index)}`,
    t,
    s: Math.round(span * index),
    e: Math.round(span * (index + 1)),
    sp: "sp1",
  }));
}

export interface FitProbe {
  readonly name: string;
  readonly script: WordScript;
  readonly words: readonly RenderWord[];
  readonly segment: { readonly id: string; readonly startMs: number; readonly endMs: number };
  readonly timestamps: readonly number[];
}

/**
 * Timestamps that walk every chunk a `wordsPerCue` style shows, so the probe
 * sees the widest chunk rather than whichever one happens to be up at 1500 ms.
 */
export function sweep(durationMs: number, steps = 12): number[] {
  return Array.from({ length: steps }, (_entry, index) =>
    Math.round((durationMs * (index + 0.5)) / steps),
  );
}

/**
 * The budget-filling caption for one style, in each of the three scripts —
 * filled to the budget `fitBudget` measures for that style on that canvas, not
 * to the readability cap, because that is the caption the segmenter would cut.
 */
export function budgetProbes(style: StyleDoc, context: FitContext, canvas: CanvasSize): FitProbe[] {
  return (["latin", "devanagari", "tamil"] as const).map((script) => {
    const budget = fitBudget({ style, script, canvas, ...context });
    return {
      name: `budget:${script}`,
      script,
      words: budgetFillingWords(script, budget.maxLines, 3000, budget.maxChars),
      segment: { id: `probe-${script}`, startMs: 0, endMs: 3000 },
      timestamps: sweep(3000),
    };
  });
}

export interface FitResult {
  readonly shrink: number;
  readonly probe: string;
  readonly tMs: number;
  readonly canvas: string;
  readonly lines: number;
}

export interface FitContext {
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
}

/**
 * The worst shrink over every probe and instant, restricted to the layouts that
 * were actually drawn in `script`.
 *
 * Restricting by the **detected** script is what makes per-script tuning
 * well-defined: `typography.scriptScale.deva` only moves layouts whose words are
 * Devanagari, so only those may be measured against it. It also picks up the
 * mixed fixtures for free — a Hinglish caption whose visible window is
 * Devanagari is measured as Devanagari, which is how it will be drawn.
 *
 * `undefined` means the style never drew that script at all, which is not a
 * failure: a probe set may simply contain no Tamil.
 */
export function worstFitForScript(
  style: StyleDoc,
  probes: readonly FitProbe[],
  canvas: CanvasSize,
  context: FitContext,
  canvasName: string,
  script: WordScript,
): FitResult | undefined {
  let worst: FitResult | undefined;
  for (const probe of probes) {
    for (const tMs of probe.timestamps) {
      const layout = layoutSegment({
        style,
        segment: probe.segment,
        words: probe.words,
        canvas,
        registry: context.registry,
        shaper: context.shaper,
        tMs,
      });
      if (layout.script !== script) continue;
      if (worst === undefined || layout.shrink < worst.shrink) {
        worst = {
          shrink: layout.shrink,
          probe: probe.name,
          tMs,
          canvas: canvasName,
          lines: layout.lines.length,
        };
      }
    }
  }
  return worst;
}

/** The worst shrink a style suffers over every probe and instant on one canvas. */
export function worstFit(
  style: StyleDoc,
  probes: readonly FitProbe[],
  canvas: CanvasSize,
  context: FitContext,
  canvasName: string,
): FitResult {
  let worst: FitResult = { shrink: 1, probe: "none", tMs: 0, canvas: canvasName, lines: 0 };
  for (const probe of probes) {
    for (const tMs of probe.timestamps) {
      const layout = layoutSegment({
        style,
        segment: probe.segment,
        words: probe.words,
        canvas,
        registry: context.registry,
        shaper: context.shaper,
        tMs,
      });
      if (layout.shrink < worst.shrink) {
        worst = {
          shrink: layout.shrink,
          probe: probe.name,
          tMs,
          canvas: canvasName,
          lines: layout.lines.length,
        };
      }
    }
  }
  return worst;
}
