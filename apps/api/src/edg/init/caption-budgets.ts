import type { Aspect } from "@montaj/edg/schemas";
import { limitsFor, type WordScript } from "@montaj/edg/segmenter";

import { CAPTION_BOUNDS, DEFAULT_STYLE_REF } from "./transcript-init.js";

import type { CaptionPreferences } from "./transcript-init.js";

/**
 * How many characters a caption line may hold (decision D78).
 *
 * The numbers in `09 §3` — Latin 32, Devanagari 24, Tamil 22 — are a
 * **readability** cap: how much text a viewer can read in the time the caption is
 * on screen. They are not the only cap. A line also has to *fit*: at 96 px on a
 * 1080-wide 9:16 canvas, 32 Latin characters do not, and a caption that overflows
 * its safe area is worse than one that is a word short.
 *
 * So the budget is
 *
 * ```
 * maxChars = min(readability cap, fit cap)
 * maxLines = min(2, fit cap's lines)
 * ```
 *
 * The **fit** half is `fitBudget({style, script, canvas, registry, shaper})` in
 * `@montaj/render-core` (A16d) — it shapes the actual glyphs of the actual style
 * with HarfBuzz, which is the only way to know what fits and the reason the number
 * cannot be a constant in this file.
 *
 * ### The seam
 *
 * A16d is not on `main` yet, and `apps/api` does not depend on `@montaj/render-core`
 * at all. {@link resolveBudgets} is therefore written as the `min` it will always
 * be, with the fit half absent: today it returns the readability cap and reports
 * `source: "readability"`. When `fitBudget` lands, {@link fitCapFor} is the one
 * function that changes — it gains the import, the font registry and the shaper —
 * and every caller, every recorded budget and every test stays as it is.
 *
 * Readability caps and the two-line maximum are **maxima** either way: the fit cap
 * can only narrow them, never widen them, which is what keeps a large style from
 * quietly producing 40-character lines.
 */

export interface CaptionBudgets {
  /** Characters a line may hold: `min(readability, fit)`. */
  readonly maxChars: number;
  /** Lines a caption may occupy. Never more than 2 (`09 §3`). */
  readonly maxLines: number;
  /** The script the readability cap came from. */
  readonly script: WordScript;
  /** The canvas the fit cap was (or will be) measured against. */
  readonly aspect: Aspect;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly styleRef: string;
  /** Which halves actually contributed. `"fit"` once A16d is wired in. */
  readonly source: "readability" | "fit";
  /** The readability cap on its own, so a later reflow can tell the two apart. */
  readonly readabilityChars: number;
}

/** Render resolutions per aspect (`05 §4`), the same table `EdgService` uses. */
export const CANVAS_SIZES: Readonly<Record<Aspect, { width: number; height: number }>> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

/** `projects.aspect` values → the CONTRACTS §2 spelling. */
const ASPECTS: Readonly<Record<string, Aspect>> = {
  r9x16: "9:16",
  r16x9: "16:9",
  r1x1: "1:1",
  r4x5: "4:5",
};

/** The aspect a project row names, defaulting to the vertical creator format. */
export function aspectOf(stored: string | null | undefined): Aspect {
  return (stored === null || stored === undefined ? undefined : ASPECTS[stored]) ?? "9:16";
}

/**
 * The canvas a caption will actually be laid out on.
 *
 * A creator project is 9:16 by default, and that default is what `projects.aspect`
 * holds until somebody chooses otherwise. When the media itself is **landscape**,
 * that default is almost certainly not what the user meant, and measuring a fit
 * budget against a 1080-wide canvas for a video that will be rendered 1920 wide
 * would give every caption half the line it deserves. So the probe wins over the
 * untouched default — and only over the default: an aspect the user has chosen is
 * never second-guessed.
 */
export function canvasAspectFor(
  storedAspect: string | null | undefined,
  media?: { readonly width?: number | null; readonly height?: number | null },
): Aspect {
  const aspect = aspectOf(storedAspect);
  if (aspect !== "9:16") return aspect;

  const width = media?.width ?? null;
  const height = media?.height ?? null;
  if (width === null || height === null || width <= 0 || height <= 0) return aspect;
  return width > height ? "16:9" : aspect;
}

/**
 * The fit cap for a style on a canvas, or `undefined` while A16d is not available.
 *
 * **This is the switch point.** When `packages/render-core/src/index.ts` exports
 * `fitBudget`, this becomes:
 *
 * ```ts
 * const fit = fitBudget({ style, script, canvas, registry, shaper });
 * return { maxChars: fit.maxChars, maxLines: fit.maxLines };
 * ```
 *
 * and {@link resolveBudgets} starts reporting `source: "fit"` without any other
 * edit. Until then it returns nothing, and the `min` below is the readability cap
 * alone — which is the correct conservative answer, not a placeholder number.
 */
export function fitCapFor(_input: {
  readonly script: WordScript;
  readonly aspect: Aspect;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly styleRef: string;
}): { maxChars: number; maxLines: number } | undefined {
  return undefined;
}

export interface ResolveBudgetsInput {
  /** The script the transcript is actually written in (the segmenter detects it). */
  readonly script: WordScript;
  /** `projects.aspect`, as stored. */
  readonly aspect?: string | null;
  /** The probed primary media, when there is one. */
  readonly media?: { readonly width?: number | null; readonly height?: number | null };
  readonly styleRef?: string;
  /** Workspace caption preferences. They can only narrow the budget. */
  readonly preferences?: CaptionPreferences;
}

/** `min(readability cap, fit cap, the workspace's own preference)`. */
export function resolveBudgets(input: ResolveBudgetsInput): CaptionBudgets {
  const aspect = canvasAspectFor(input.aspect, input.media);
  const canvas = CANVAS_SIZES[aspect];
  const styleRef = input.styleRef ?? DEFAULT_STYLE_REF;

  const readability = limitsFor(input.script);
  const fit = fitCapFor({ script: input.script, aspect, canvas, styleRef });

  const caps: number[] = [readability.maxCharsPerLine];
  const lineCaps: number[] = [CAPTION_BOUNDS.maxLines.max - 1];
  if (fit !== undefined) {
    caps.push(fit.maxChars);
    lineCaps.push(fit.maxLines);
  }
  // A workspace asking for narrower captions is another cap, never a licence to
  // exceed the readability limit.
  if (input.preferences?.maxChars !== undefined) caps.push(input.preferences.maxChars);
  if (input.preferences?.maxLines !== undefined) lineCaps.push(input.preferences.maxLines);

  return {
    maxChars: Math.max(CAPTION_BOUNDS.maxChars.min, Math.min(...caps)),
    maxLines: Math.max(1, Math.min(...lineCaps)),
    script: input.script,
    aspect,
    canvas,
    styleRef,
    source: fit === undefined ? "readability" : "fit",
    readabilityChars: readability.maxCharsPerLine,
  };
}

/**
 * The budgets as `EdgHot.meta.engineVersions` can carry them.
 *
 * CONTRACTS §2 types `engineVersions` as `Record<string, string>`, so the object
 * travels as compact JSON under one key. A15 parses it to offer "Reflow captions"
 * when the style changes — it needs to know both what the budget *was* and which
 * half produced it, because a reflow is only worth offering when the fit half
 * would now answer differently.
 */
export function budgetsForMeta(budgets: CaptionBudgets): Record<string, string> {
  return {
    segmenter: `${budgets.source}@1`,
    captionBudgets: JSON.stringify({
      maxChars: budgets.maxChars,
      maxLines: budgets.maxLines,
      script: budgets.script,
      aspect: budgets.aspect,
      styleRef: budgets.styleRef,
      source: budgets.source,
      readabilityChars: budgets.readabilityChars,
    }),
  };
}
