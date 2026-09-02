import type { Word } from "@montaj/edg/schemas";

import lexiconFile from "./fillers.json";

import type { Correction, StepResult } from "./corrections.js";

/**
 * Filler tagging (`09 §3`).
 *
 * The lexicon is a **data file** (`fillers.json`) rather than a table in code,
 * because it is content: it grows one language at a time, a linguist should be
 * able to read the diff, and B09 will eventually let a workspace add to it. The
 * code here is only the matcher.
 *
 * Three kinds of entry, and the difference matters:
 *
 * * **single** — a word that is a filler wherever it appears (`um`, `matlab`).
 * * **phrase** — a filler spelled across several words (`you know`,
 *   `kya bolte hain`). Matched over the word sequence, so every word in the run
 *   is tagged and the autocut pass can remove the whole thing.
 * * **contextual** — an ordinary word that is *sometimes* a hesitation. `09 §3`
 *   spells this out for `toh`, and the same is true of `like`, `so` and `haan`:
 *   "toh main gaya" is a sentence, "toh… main gaya" is a stall. A contextual
 *   entry is tagged only when a pause of at least `contextualPauseMs` brackets
 *   it, which is the acoustic difference between the two.
 *
 * A flag the worker already set is **never cleared** — a provider that tags its
 * own disfluencies knows things this lexicon does not — so the step only ever
 * adds `filler: true`.
 */

interface LanguageLexicon {
  readonly single?: readonly string[];
  readonly phrases?: readonly string[];
  readonly contextual?: readonly string[];
}

interface LexiconFile {
  readonly version: number;
  readonly contextualPauseMs: number;
  readonly languages: Readonly<Record<string, LanguageLexicon>>;
}

const LEXICON = lexiconFile as LexiconFile;

export interface FillerLexicon {
  readonly single: ReadonlySet<string>;
  readonly contextual: ReadonlySet<string>;
  /** Phrases as token arrays, longest first, so `you know what` beats `you know`. */
  readonly phrases: readonly (readonly string[])[];
  readonly contextualPauseMs: number;
}

/**
 * Punctuation and case are the provider's; matching is on the bare token.
 *
 * Combining marks stay: `मतलब` and `இன்று` end in them, and stripping them would
 * leave a token that matches nothing in any lexicon.
 */
export function normaliseToken(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, "");
}

/**
 * Language keys whose lexicons apply to a transcript.
 *
 * A BCP-47 tag is matched on its parts, so `hi-Latn` reads Roman Hindi and
 * English (Hinglish is both), `hi-Deva` reads the Devanagari list, and an unknown
 * tag still gets English — every Indian creator transcript carries English
 * discourse markers whatever the base language is.
 */
export function lexiconKeysFor(language: string): string[] {
  const base = (language.split("-")[0] ?? language).toLowerCase();
  const keys = new Set<string>(["en"]);
  if (base !== "") {
    // Every lexicon for the base language, whatever script it names. A Hinglish
    // transcript switches script word by word, and tagging by the tag's own
    // script would leave every Devanagari `मतलब` in a `hi-Latn` transcript
    // untagged. A Devanagari filler is never an accidental match in Roman text,
    // so loading both costs nothing and misses nothing.
    for (const key of Object.keys(LEXICON.languages)) {
      if (key === base || key.toLowerCase().startsWith(`${base}-`)) keys.add(key);
    }
    keys.add(base);
  }
  return [...keys];
}

/** The merged lexicon for a language tag. */
export function lexiconFor(language: string): FillerLexicon {
  const single = new Set<string>();
  const contextual = new Set<string>();
  const phrases: string[][] = [];

  for (const key of lexiconKeysFor(language)) {
    const entry = LEXICON.languages[key];
    if (entry === undefined) continue;
    for (const word of entry.single ?? []) single.add(normaliseToken(word));
    for (const word of entry.contextual ?? []) contextual.add(normaliseToken(word));
    for (const phrase of entry.phrases ?? []) {
      const tokens = phrase.split(/\s+/).map(normaliseToken).filter(Boolean);
      if (tokens.length > 1) phrases.push(tokens);
    }
  }
  // Longest first so a phrase is never shadowed by a shorter one that starts it.
  phrases.sort((left, right) => right.length - left.length);

  return { single, contextual, phrases, contextualPauseMs: LEXICON.contextualPauseMs };
}

/** Every language the shipped lexicon covers, for diagnostics and the README. */
export function lexiconLanguages(): string[] {
  return Object.keys(LEXICON.languages).sort();
}

/**
 * Tag fillers in one chunk's words.
 *
 * Pure and order-independent within a chunk: the decision for a word depends only
 * on the word, the lexicon and the two gaps around it.
 */
export function tagFillers(words: readonly Word[], language: string): StepResult {
  const lexicon = lexiconFor(language);
  const tokens = words.map((word) => normaliseToken(word.t));
  const flagged = new Set<number>();
  const reasons = new Map<number, string>();

  // Phrases first: a phrase match wins over the single-word verdict for its parts.
  for (const phrase of lexicon.phrases) {
    for (let index = 0; index + phrase.length <= tokens.length; index += 1) {
      if (!phrase.every((token, offset) => tokens[index + offset] === token)) continue;
      for (let offset = 0; offset < phrase.length; offset += 1) {
        flagged.add(index + offset);
        reasons.set(index + offset, `phrase "${phrase.join(" ")}"`);
      }
    }
  }

  for (const [index, token] of tokens.entries()) {
    if (token === "" || flagged.has(index)) continue;
    if (lexicon.single.has(token)) {
      flagged.add(index);
      reasons.set(index, `filler "${token}"`);
      continue;
    }
    if (!lexicon.contextual.has(token)) continue;
    if (bracketedByPause(words, index, lexicon.contextualPauseMs)) {
      flagged.add(index);
      reasons.set(index, `contextual filler "${token}" bracketed by a pause`);
    }
  }

  const corrections: Correction[] = [];
  const result = words.map((word, index) => {
    if (!flagged.has(index) || word.filler === true) return word;
    corrections.push({
      step: "fillers",
      wordId: word.wid,
      before: word.t,
      after: word.t,
      reason: reasons.get(index) ?? "filler",
    });
    return { ...word, filler: true };
  });

  return { words: result, corrections };
}

/** Is the word surrounded by enough silence to be a hesitation rather than a word? */
function bracketedByPause(words: readonly Word[], index: number, pauseMs: number): boolean {
  const word = words[index];
  if (word === undefined) return false;
  const previous = words[index - 1];
  const next = words[index + 1];
  // The first and last words of a chunk have silence on the outside by definition.
  const before = previous === undefined ? pauseMs : word.s - previous.e;
  const after = next === undefined ? pauseMs : next.s - word.e;
  return before >= pauseMs || after >= pauseMs;
}
