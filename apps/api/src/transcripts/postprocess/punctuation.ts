import type { Word } from "@montaj/edg/schemas";

import { withText } from "./corrections.js";

import type { Correction, StepResult } from "./corrections.js";

/**
 * Punctuation and casing restoration.
 *
 * Rule-based, and deliberately conservative: a wrong full stop splits a caption
 * in the wrong place, and a caption is read once at speed. The rules are the two
 * signals an ASR transcript actually carries:
 *
 * * **The provider's own punctuation**, which is trusted wherever it exists. A
 *   word that already ends a sentence is never re-punctuated.
 * * **The pause after a word.** A gap of at least `sentencePauseMs` (600 ms, the
 *   figure in the brief) is a sentence boundary; shorter gaps are not, because
 *   Hindi and Tamil speech is full of 200–400 ms phrase breaks that are commas at
 *   most.
 *
 * Casing is applied **only to Latin script**: Devanagari and Tamil have no case,
 * and upper-casing a Devanagari code point is a no-op that would still be logged
 * as a correction and pollute the eval harness.
 *
 * {@link PunctuationModel} is the seam a learned model drops into. The rule-based
 * implementation is the default and the fallback; a model that fails or is not
 * configured leaves the rules in place rather than leaving the transcript bare.
 */

export interface PunctuationParams {
  /** Silence that ends a sentence, in ms. */
  readonly sentencePauseMs: number;
  /** Sentence terminator for the transcript's script. */
  readonly terminator: string;
  /** Restore capitals. False for scripts that have none. */
  readonly capitalise: boolean;
}

/** Devanagari sentences end in a danda; Latin and Tamil in a full stop. */
export function defaultPunctuationParams(language: string): PunctuationParams {
  const devanagari = /deva/i.test(language) || /^(hi|mr|ne|sa)$/i.test(language);
  return {
    sentencePauseMs: 600,
    terminator: devanagari ? "।" : ".",
    capitalise: !devanagari,
  };
}

/**
 * The seam for a learned punctuation model.
 *
 * A model returns the punctuated text for each word, in order, or `undefined` to
 * decline (unsupported language, budget spent, service down). Declining is not an
 * error: the rule-based pass runs either way and the transcript is never left
 * without sentence boundaries, which the segmenter needs to break on.
 */
export interface PunctuationModel {
  readonly name: string;
  punctuate(
    words: readonly Word[],
    language: string,
  ): Promise<readonly string[] | undefined> | readonly string[] | undefined;
}

/** Sentence-final punctuation, optionally followed by a closing quote or bracket. */
const SENTENCE_END = /[.!?…।॥]["'”’)\]]*$/u;
/**
 * Any trailing punctuation at all — a comma is a boundary the rules must not
 * double. `\p{M}` is in the class because an Indic word very often *ends* in a
 * combining vowel sign (`இன்று`, `करेंगे`): without it, every second Devanagari
 * and Tamil word would look to this rule like it already ended in punctuation.
 */
const ENDS_IN_PUNCTUATION = /[^\p{L}\p{N}\p{M}]$/u;

export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trim());
}

/**
 * Restore sentence boundaries and capitals over one chunk's words.
 *
 * The last word of a chunk is **not** terminated: a 10-minute chunk boundary
 * falls wherever the chunk plan put it, not where a sentence ended, and a full
 * stop there would be a claim the audio does not support.
 */
export function restorePunctuation(words: readonly Word[], params: PunctuationParams): StepResult {
  const corrections: Correction[] = [];
  const out: Word[] = [];
  let startOfSentence = true;

  for (const [index, word] of words.entries()) {
    const next = words[index + 1];
    const gap = next === undefined ? 0 : next.s - word.e;
    const lastInChunk = next === undefined;

    let text = word.t;
    if (params.capitalise && startOfSentence) text = capitalise(text);
    if (
      !lastInChunk &&
      gap >= params.sentencePauseMs &&
      !endsSentence(text) &&
      !ENDS_IN_PUNCTUATION.test(text)
    ) {
      text += params.terminator;
    }

    if (text !== word.t) {
      corrections.push({
        step: "punctuation",
        wordId: word.wid,
        before: word.t,
        after: text,
        reason: endsSentence(text) ? `pause of ${String(gap)} ms after the word` : "sentence start",
      });
      out.push(withText(word, text));
    } else {
      out.push(word);
    }
    startOfSentence = endsSentence(text);
  }

  return { words: out, corrections };
}

/** Upper-case the first letter, and only when the script has one. */
function capitalise(text: string): string {
  const first = [...text][0];
  if (first === undefined) return text;
  const upper = first.toLocaleUpperCase("en");
  if (upper === first || upper.length !== first.length) return text;
  return upper + text.slice(first.length);
}

/**
 * Run a model when one is configured, then the rules over what it returned.
 *
 * The rules run **after** the model on purpose: a model that punctuates most of a
 * transcript and misses the tail still leaves a transcript the segmenter can
 * break on, and a model that returns the wrong number of words is discarded
 * whole rather than realigned by guesswork.
 */
export async function punctuate(
  words: readonly Word[],
  language: string,
  params: PunctuationParams,
  model?: PunctuationModel,
): Promise<StepResult> {
  if (model === undefined) return restorePunctuation(words, params);

  let texts: readonly string[] | undefined;
  try {
    texts = await model.punctuate(words, language);
  } catch {
    texts = undefined;
  }
  if (texts === undefined || texts.length !== words.length) {
    return restorePunctuation(words, params);
  }

  const corrections: Correction[] = [];
  const modelled = words.map((word, index) => {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const text = texts[index] ?? word.t;
    if (text === word.t) return word;
    corrections.push({
      step: "punctuation",
      wordId: word.wid,
      before: word.t,
      after: text,
      reason: `model ${model.name}`,
    });
    return withText(word, text);
  });

  const rules = restorePunctuation(modelled, params);
  return { words: rules.words, corrections: [...corrections, ...rules.corrections] };
}
