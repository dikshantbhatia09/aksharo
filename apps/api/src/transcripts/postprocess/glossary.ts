import type { Word } from "@montaj/edg/schemas";

import { withText } from "./corrections.js";
import { editDistance, phoneticKey } from "./phonetic.js";

import type { Correction, PostProcessStep, StepResult } from "./corrections.js";

/**
 * Glossary boosting, post-correction half (`09 §3`).
 *
 * Boosting has two halves and this is the one the API owns. Where a provider
 * supports hotword prompts, A09 passes the workspace's terms in `hints` and the
 * ASR is more likely to produce them in the first place. Where it does not — or
 * where it produces "Achsharo" anyway — the term is restored here, by matching
 * the **sound** of the word rather than its spelling, and every substitution is
 * logged so the user can see what was changed on their behalf.
 *
 * **Two sources, one matcher.** A workspace *glossary* is what the user told us
 * to spell that way; a remembered *spelling* is what B09 observed the user
 * correcting. They are matched identically and logged under different steps, so
 * "the glossary did this" and "your memory did this" are distinguishable in the
 * corrections log — which matters, because only the second is consent-gated.
 *
 * **The gate.** {@link GlossarySource} is the seam: this module never reads
 * `memory_entries` and never checks a consent record. `MemoryGlossarySource`
 * (`glossary.source.ts`) does both, and a workspace without memory consent simply
 * yields no spelling terms — there is no flag in here to get wrong.
 */

export interface GlossaryTerm {
  /** The spelling to restore, exactly as it should appear. */
  readonly term: string;
  /** Other spellings that mean the same term; matched the same way. */
  readonly aliases?: readonly string[];
  /** Which step logs the correction — and therefore which consent it needed. */
  readonly source: Extract<PostProcessStep, "glossary" | "spelling">;
}

/**
 * Where the terms come from. B09 supplies the real implementation over
 * `memory_entries`; A11 ships the interface and a database-backed reader.
 */
export interface GlossarySource {
  /** Terms for one workspace, already consent-filtered. */
  terms(workspaceId: string): Promise<readonly GlossaryTerm[]>;
}

/** A source that has nothing to say. The default, and what a test uses. */
export const EMPTY_GLOSSARY_SOURCE: GlossarySource = {
  terms: async () => [],
};

/** Longest edit distance that still counts as the same word (brief §3). */
export const MAX_GLOSSARY_DISTANCE = 2;

interface IndexedTerm {
  readonly term: GlossaryTerm;
  /** The spelling that matched, so an alias hit reports itself honestly. */
  readonly spelling: string;
  readonly normalised: string;
}

export interface GlossaryIndex {
  readonly byKey: ReadonlyMap<string, readonly IndexedTerm[]>;
  readonly size: number;
}

/** Case-folded, punctuation off both ends — but never a combining mark (see `numerals.ts`). */
function normalise(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, "");
}

/** Trailing punctuation a correction must preserve. */
function trailing(text: string): string {
  const match = /[^\p{L}\p{N}\p{M}]+$/u.exec(text.normalize("NFC"));
  return match?.[0] ?? "";
}

/** Build the phonetic bucket map once per transcription. */
export function buildGlossaryIndex(terms: readonly GlossaryTerm[]): GlossaryIndex {
  const byKey = new Map<string, IndexedTerm[]>();
  let size = 0;

  for (const term of terms) {
    for (const spelling of [term.term, ...(term.aliases ?? [])]) {
      const normalised = normalise(spelling);
      if (normalised === "") continue;
      const key = phoneticKey(spelling);
      if (key === "") continue;
      const bucket = byKey.get(key) ?? [];
      bucket.push({ term, spelling, normalised });
      byKey.set(key, bucket);
      size += 1;
    }
  }
  return { byKey, size };
}

/**
 * Correct one chunk's words against the index.
 *
 * A word is rewritten when its phonetic key lands in a bucket **and** it is
 * within {@link MAX_GLOSSARY_DISTANCE} edits of one of the spellings there. Both
 * halves are needed: the key alone would rewrite "sharp" to "Sarvam" on a shared
 * skeleton, and the distance alone would rewrite half the transcript.
 *
 * A word that already reads as the canonical term is left alone — including its
 * case, because "AKSHARO" at the start of a shouted sentence is the speaker's
 * emphasis and not a spelling mistake.
 */
export function applyGlossary(words: readonly Word[], index: GlossaryIndex): StepResult {
  if (index.size === 0) return { words, corrections: [] };

  const corrections: Correction[] = [];
  const out = words.map((word) => {
    const normalised = normalise(word.t);
    if (normalised === "") return word;

    const bucket = index.byKey.get(phoneticKey(word.t));
    if (bucket === undefined) return word;

    let best: { entry: IndexedTerm; distance: number } | undefined;
    for (const entry of bucket) {
      const distance = editDistance(normalised, entry.normalised, MAX_GLOSSARY_DISTANCE);
      if (distance > MAX_GLOSSARY_DISTANCE) continue;
      // Ties break on the shorter distance, then on the term's own order, so the
      // result does not depend on Map iteration luck.
      if (best === undefined || distance < best.distance) best = { entry, distance };
    }
    if (best === undefined) return word;

    const canonical = best.entry.term.term;
    if (normalised === normalise(canonical)) return word;

    const text = canonical + trailing(word.t);
    corrections.push({
      step: best.entry.term.source,
      wordId: word.wid,
      before: word.t,
      after: text,
      reason:
        best.entry.spelling === canonical
          ? `${best.entry.term.source} term "${canonical}" (distance ${String(best.distance)})`
          : `${best.entry.term.source} alias "${best.entry.spelling}" of "${canonical}"`,
    });
    return withText(word, text);
  });

  return { words: out, corrections };
}
