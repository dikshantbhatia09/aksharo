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
  latin: ["editing", "transcript", "brother", "simple", "caption", "video", "today", "learn"],
  devanagari: ["ट्रांसक्रिप्ट", "मुश्किल", "करेंगे", "बारे", "पहले", "आसान", "देखो", "बहुत"],
  tamil: ["எடிட்டிங்", "வீடியோ", "பேசுவோம்", "இன்று", "பற்றி", "நாம்", "வசனங்கள்", "இப்படி"],
  other: ["editing", "transcript", "brother", "simple", "caption", "video", "today", "learn"],
};

/**
 * A caption that fills `maxLines` lines to the script's character budget — the
 * worst case the segmenter is allowed to hand the renderer.
 */
export function budgetFillingWords(
  script: WordScript,
  maxLines: number,
  durationMs = 3000,
): RenderWord[] {
  const pool = WORD_POOL[script];
  const budget = limitsFor(script).maxCharsPerLine;
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

/** The budget-filling caption for one style, in each of the three scripts. */
export function budgetProbes(style: StyleDoc): FitProbe[] {
  return (["latin", "devanagari", "tamil"] as const).map((script) => ({
    name: `budget:${script}`,
    script,
    words: budgetFillingWords(script, style.layout.maxLines),
    segment: { id: `probe-${script}`, startMs: 0, endMs: 3000 },
    timestamps: sweep(3000),
  }));
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
