import { Logger } from "@nestjs/common";

import { loadSystemStyleMap, type StyleDoc } from "@montaj/caption-styles";
import type { Aspect } from "@montaj/edg/schemas";
import { limitsFor, type WordScript } from "@montaj/edg/segmenter";
import { fitBudget, type FitBudgetOptions, type LineBudget } from "@montaj/render-core";

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
 * ### What decides whether the fit half runs
 *
 * `fitBudget` measures through the **real shaper and the real faces**: it needs a
 * {@link CaptionRenderContext} (a `FontRegistry` and a `Shaper`). A18b is the work
 * package that registers the production subset faces; until it does, nothing binds
 * {@link CAPTION_RENDER_CONTEXT}, {@link fitCapFor} answers `undefined`, and the
 * budget is the readability cap reported as `source: "readability"`.
 *
 * That absence is deliberate rather than a stub. `averageAdvanceEm` raises
 * `render/no-font` instead of guessing when nothing can draw the sample, and a
 * budget measured against a placeholder face would be a *wrong* number wearing the
 * word "measured" — worse than the honest cap. The call itself is wired and
 * covered (`transcript-init.test.ts` drives it through `createFixtureRenderer`),
 * so the day a registry is bound the budgets narrow and `source` becomes `"fit"`
 * with no further edit.
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
  /** What the type metrics alone allowed, when the fit half ran. */
  readonly fitChars?: number;
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
 * What `fitBudget` needs beyond the style, the script and the canvas.
 *
 * A18b binds it; nothing does yet. Injected optionally, so the API boots and
 * transcribes without a font stack at all.
 */
export type CaptionRenderContext = Pick<FitBudgetOptions, "registry" | "shaper">;

/** DI token for {@link CaptionRenderContext}. Optional by design. */
export const CAPTION_RENDER_CONTEXT = Symbol("CAPTION_RENDER_CONTEXT");

const logger = new Logger("CaptionBudgets");

/** The system style catalogue, loaded once. */
let catalogue: Map<string, StyleDoc> | undefined;

/** One system style by id, or `undefined` — a brand-kit style is B10's. */
export function systemStyle(styleRef: string): StyleDoc | undefined {
  const loaded = (catalogue ??= loadSystemStyleMap());
  return loaded.get(styleRef);
}

/**
 * The fit cap for a style on a canvas: `fitBudget` from `@montaj/render-core`
 * (A16d), measured through the real shaper.
 *
 * `undefined` when the fit half cannot answer — no render context bound, an
 * unknown style id, or `render/no-font` because the registry cannot draw the
 * script's sample. Every one of those is a reason to fall back to the readability
 * cap rather than to a guess, and the failure is logged so an operator can see
 * that the fit half is not running.
 */
export function fitCapFor(input: {
  readonly script: WordScript;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly styleRef: string;
  readonly render?: CaptionRenderContext;
}): LineBudget | undefined {
  if (input.render === undefined) return undefined;

  const style = systemStyle(input.styleRef);
  if (style === undefined) {
    logger.warn({ styleRef: input.styleRef }, "no system style; using the readability cap");
    return undefined;
  }

  try {
    return fitBudget({
      style,
      script: input.script,
      canvas: input.canvas,
      registry: input.render.registry,
      shaper: input.render.shaper,
    });
  } catch (error) {
    logger.warn(
      {
        styleRef: input.styleRef,
        script: input.script,
        err: error instanceof Error ? error.message : String(error),
      },
      "fit budget unavailable; using the readability cap",
    );
    return undefined;
  }
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
  /** The font stack the fit half measures through. Absent until A18b binds one. */
  readonly render?: CaptionRenderContext;
}

/** `min(readability cap, fit cap, the workspace's own preference)`. */
export function resolveBudgets(input: ResolveBudgetsInput): CaptionBudgets {
  const aspect = canvasAspectFor(input.aspect, input.media);
  const canvas = CANVAS_SIZES[aspect];
  const styleRef = input.styleRef ?? DEFAULT_STYLE_REF;

  const readability = limitsFor(input.script);
  const fit = fitCapFor({
    script: input.script,
    canvas,
    styleRef,
    ...(input.render === undefined ? {} : { render: input.render }),
  });

  const caps: number[] = [readability.maxCharsPerLine];
  const lineCaps: number[] = [CAPTION_BOUNDS.maxLines.max - 1];
  if (fit !== undefined) {
    caps.push(fit.maxChars);
    lineCaps.push(fit.maxLines);
  }
  // A workspace asking for narrower captions is another cap, never a licence to
  // exceed the readability limit — and its own bounds are clamped here rather
  // than applied to the result, because a floor applied at the end would silently
  // WIDEN a measured fit cap and put the caption back outside its box.
  if (input.preferences?.maxChars !== undefined) {
    caps.push(clamp(input.preferences.maxChars, CAPTION_BOUNDS.maxChars));
  }
  if (input.preferences?.maxLines !== undefined) {
    lineCaps.push(clamp(input.preferences.maxLines, CAPTION_BOUNDS.maxLines));
  }

  return {
    // Floored at 1, as `fitBudget` floors it: a budget of zero is not a number of
    // characters, and anything above 1 is honoured exactly as measured.
    maxChars: Math.max(1, Math.min(...caps)),
    maxLines: Math.max(1, Math.min(...lineCaps)),
    script: input.script,
    aspect,
    canvas,
    styleRef,
    source: fit === undefined ? "readability" : "fit",
    readabilityChars: readability.maxCharsPerLine,
    ...(fit === undefined ? {} : { fitChars: fit.fitMaxChars }),
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
      ...(budgets.fitChars === undefined ? {} : { fitChars: budgets.fitChars }),
    }),
  };
}

/** Clamp a preference into the bounds a caption can actually be read at. */
function clamp(value: number, bounds: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}
