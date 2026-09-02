import type { Word } from "@montaj/edg/schemas";

/**
 * What every post-processing step records about itself.
 *
 * A correction is the eval harness's unit of account (`09 §8`) and the user's
 * answer to "why does the transcript say that?". Every step therefore reports the
 * word it touched, what the ASR gave and what the API put in its place — never
 * just "17 corrections applied", which is unreviewable.
 */
export const POSTPROCESS_STEPS = [
  "punctuation",
  "numerals",
  "glossary",
  "spelling",
  "fillers",
  "speakers",
] as const;

export type PostProcessStep = (typeof POSTPROCESS_STEPS)[number];

export interface Correction {
  readonly step: PostProcessStep;
  readonly wordId: string;
  /** The text as the provider sent it. */
  readonly before: string;
  /** The text as it was stored. Equal to `before` for a flag-only change. */
  readonly after: string;
  /** Why, in a form a human can review: the glossary term, the filler lexicon entry. */
  readonly reason?: string;
}

/** A step's verdict: the words it produced and what it changed doing so. */
export interface StepResult {
  readonly words: readonly Word[];
  readonly corrections: readonly Correction[];
}

/** Convenience for a step that changed nothing. */
export function unchanged(words: readonly Word[]): StepResult {
  return { words, corrections: [] };
}

/** Replace `t` (and the matching script slot) without disturbing anything else. */
export function withText(word: Word, text: string): Word {
  if (word.t === text) return word;
  const scripts = word.scripts;
  if (scripts === undefined) return { ...word, t: text };

  // The primary text is one of the script slots; whichever slot held the old
  // spelling holds the new one, so `scripts` never contradicts `t`.
  const updated = { ...scripts };
  let touched = false;
  for (const key of ["roman", "native", "en"] as const) {
    if (updated[key] === word.t) {
      updated[key] = text;
      touched = true;
    }
  }
  return { ...word, t: text, ...(touched ? { scripts: updated } : {}) };
}
