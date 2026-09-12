import type { Speaker, TranscriptChunk, Word } from "@montaj/edg/schemas";

import { tagFillers } from "./fillers.js";
import { buildGlossaryIndex, applyGlossary, EMPTY_GLOSSARY_SOURCE } from "./glossary.js";
import { identifyLanguage } from "./lid.js";
import { defaultNumeralParams, normaliseNumerals } from "./numerals.js";
import { defaultPunctuationParams, punctuate } from "./punctuation.js";
import { normaliseSpeakers } from "./speakers.js";
import { devanagariToHinglish } from "./transliterate.js";
import { repairTranscriptWords } from "./repair.js";


import type { Correction, PostProcessStep } from "./corrections.js";
import type { GlossarySource, GlossaryTerm } from "./glossary.js";
import type { DetectedLanguage } from "./lid.js";
import type { NumeralParams } from "./numerals.js";
import type { PunctuationModel, PunctuationParams } from "./punctuation.js";

/**
 * The post-processing pipeline of `09 §3`, as one pure(ish) function.
 *
 * "Pure(ish)": the only impurity is {@link PostProcessOptions.glossarySource},
 * which reads the workspace's terms, and the optional punctuation model. Both are
 * awaited **before** the word passes start, so the passes themselves are ordinary
 * synchronous functions that a table-driven test can drive without a database.
 *
 * ### Order, and why it is this order
 *
 * ```
 * timings   → integer ms, clamped into the chunk        (ingest invariant)
 * speakers  → s1, s2, … by first appearance             (whole transcript)
 * LID       → two signals, one BCP-47 tag               (decides every later step)
 * punctuation → sentence boundaries and capitals        (the segmenter breaks on them)
 * numerals  → 1,20,000 / ₹ amounts                      (needs the punctuation off the token)
 * glossary  → workspace terms, then remembered spellings
 * fillers   → tagged, never removed
 * ```
 *
 * The language verdict comes first because the three passes after it are
 * language-specific — a Devanagari transcript gets a danda and no capitals, a
 * Tamil one gets neither the Hindi filler list nor Devanagari numerals. Fillers
 * come last so a word the glossary just corrected is matched on its final
 * spelling.
 *
 * Every pass reports what it changed ({@link Correction}), and the log is the
 * eval harness's input as well as the user's answer to "why does it say that?".
 */

export interface PostProcessOptions {
  /** The language the worker reported (`result.language`). */
  readonly providerLanguage: string;
  readonly providerConfidence?: number;
  readonly providerLanguages?: readonly DetectedLanguage[];
  /** A language the caller asked for; it wins over both signals. */
  readonly hint?: string;
  readonly workspaceId: string;
  /** Where glossary and remembered spellings come from. B09 supplies the real one. */
  readonly glossarySource?: GlossarySource;
  /** Terms supplied directly — the request's `hints`, and what tests use. */
  readonly extraTerms?: readonly GlossaryTerm[];
  /** A learned punctuation model, when one is configured. */
  readonly punctuationModel?: PunctuationModel;
  readonly punctuation?: Partial<PunctuationParams>;
  readonly numerals?: Partial<NumeralParams>;
}

export interface PostProcessResult {
  readonly chunks: readonly TranscriptChunk[];
  /** The resolved BCP-47 tag. */
  readonly language: string;
  readonly detectedLanguages: readonly DetectedLanguage[];
  readonly scripts: readonly ("roman" | "native" | "en")[];
  readonly speakers: readonly Speaker[];
  readonly corrections: readonly Correction[];
  /** Steps that actually changed something, in the order they ran. */
  readonly steps: readonly PostProcessStep[];
  /** True when the acoustic and orthographic signals disagreed (D14). */
  readonly languageDisagreement: boolean;
}

/**
 * Round ASR timings to integer milliseconds and clamp them into their chunk.
 *
 * `Word.s`/`Word.e` are integers by contract (A11 addendum): a provider that
 * reports 1.2345 s becomes 1234 ms here and nowhere else, so no consumer has to
 * decide whether to floor or round, and two clients never disagree about which
 * frame a word starts on. A word that runs past its chunk is clamped rather than
 * moved — the chunk plan cuts on silence precisely so that is rare (D14).
 */
export function normaliseTimings(chunk: TranscriptChunk): TranscriptChunk {
  const startMs = Math.round(chunk.startMs);
  const endMs = Math.max(startMs, Math.round(chunk.endMs));
  return {
    ...chunk,
    startMs,
    endMs,
    words: chunk.words.map((word) => {
      const s = Math.min(Math.max(Math.round(word.s), startMs), endMs);
      const e = Math.min(Math.max(Math.round(word.e), s), endMs);
      return s === word.s && e === word.e ? word : { ...word, s, e };
    }),
  };
}

function mergeSplitTokens(words: readonly Word[]): Word[] {
  const merged: Word[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const curr = words[i]!;
    const next = words[i + 1];
    // Merge split numerals like ["3", ",000"] -> "3,000" or ["2", ".5"] -> "2.5"
    if (next && /^\d+$/.test(curr.t) && /^[,.]\d+/.test(next.t)) {
      const combined = curr.t + next.t;
      merged.push({
        ...curr,
        t: combined,
        e: Math.max(curr.e, next.e),
        scripts: {
          roman: combined,
          native: combined,
        },
      });
      i += 1;
      continue;
    }
    merged.push(curr);
  }
  return merged;
}

export async function postProcess(
  input: readonly TranscriptChunk[],
  options: PostProcessOptions,
): Promise<PostProcessResult> {
  const chunks = input.map(normaliseTimings);
  const allWords = chunks.flatMap((chunk) => chunk.words);

  // 1. Speakers, over the whole transcript (see `speakers.ts`).
  const speakers = normaliseSpeakers(allWords);
  const relabelled = redistribute(chunks, speakers.words);

  // 2. Language, from both signals.
  const verdict = identifyLanguage({
    words: speakers.words,
    providerLanguage: options.providerLanguage,
    ...(options.providerConfidence === undefined
      ? {}
      : { providerConfidence: options.providerConfidence }),
    ...(options.providerLanguages === undefined
      ? {}
      : { providerLanguages: options.providerLanguages }),
    ...(options.hint === undefined ? {} : { hint: options.hint }),
  });

  // 3. The glossary index, built once for the whole transcript.
  const source = options.glossarySource ?? EMPTY_GLOSSARY_SOURCE;
  const stored = await source.terms(options.workspaceId);
  const index = buildGlossaryIndex([...stored, ...(options.extraTerms ?? [])]);

  const punctuationParams: PunctuationParams = {
    ...defaultPunctuationParams(verdict.language),
    ...options.punctuation,
  };
  const numeralParams: NumeralParams = { ...defaultNumeralParams(), ...options.numerals };

  const corrections: Correction[] = [...speakers.corrections];
  const out: TranscriptChunk[] = [];

  for (const chunk of relabelled) {
    let words: readonly Word[] = mergeSplitTokens(chunk.words);

    const punctuated = await punctuate(
      words,
      verdict.language,
      punctuationParams,
      options.punctuationModel,
    );
    corrections.push(...punctuated.corrections);
    words = punctuated.words;

    const numerals = normaliseNumerals(words, numeralParams);
    corrections.push(...numerals.corrections);
    words = numerals.words;

    const glossary = applyGlossary(words, index);
    corrections.push(...glossary.corrections);
    words = glossary.words;

    const fillers = tagFillers(words, verdict.language);
    corrections.push(...fillers.corrections);
    words = fillers.words;

    const isHinglish =
      verdict.language.toLowerCase() === "hi-latn" ||
      options.hint?.toLowerCase() === "hi-latn" ||
      options.providerLanguage?.toLowerCase() === "hi-latn";

    if (isHinglish) {
      words = words.map((w) => {
        const rawSource =
          w.scripts?.native && /[\u0900-\u097F]/u.test(w.scripts.native)
            ? w.scripts.native
            : (w.scripts?.roman ?? w.t);
        const roman = devanagariToHinglish(rawSource);
        const native = w.scripts?.native ?? w.t;
        return {
          ...w,
          t: roman,
          scripts: {
            ...w.scripts,
            roman,
            native,
          },
        };
      });

      const repaired = repairTranscriptWords(words);
      corrections.push(...repaired.corrections);
      words = repaired.words;
    }

    out.push({ ...chunk, words: [...words] });
  }

  const isHinglish =
    verdict.language.toLowerCase() === "hi-latn" ||
    options.hint?.toLowerCase() === "hi-latn" ||
    options.providerLanguage?.toLowerCase() === "hi-latn";

  const scripts = isHinglish
    ? (["roman", "native"] as const)
    : verdict.scripts;

  const steps = [...new Set(corrections.map((correction) => correction.step))];
  return {
    chunks: out,
    language: verdict.language,
    detectedLanguages: verdict.detected,
    scripts,
    speakers: speakers.speakers,
    corrections,
    steps,
    languageDisagreement: verdict.disagreed,
  };
}

/** Put a flat, transformed word list back into the chunks it came from. */
function redistribute(
  chunks: readonly TranscriptChunk[],
  words: readonly Word[],
): TranscriptChunk[] {
  let cursor = 0;
  return chunks.map((chunk) => {
    const slice = words.slice(cursor, cursor + chunk.words.length);
    cursor += chunk.words.length;
    return { ...chunk, words: slice };
  });
}
