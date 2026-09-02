/**
 * Find & replace, and "Fix spelling everywhere" — the same matcher underneath
 * both (brief §3: "'Fix spelling everywhere' on double-click uses the same
 * path"). Pure so it can be tested without a store or a DOM; the caller turns
 * the matches into a batch of `EditWord` ops via `ops.ts`'s `editWord`.
 */
import type { Word } from "@montaj/edg";

export interface FindOptions {
  readonly caseSensitive?: boolean;
  readonly regex?: boolean;
  readonly wholeWord?: boolean;
}

export interface WordMatch {
  readonly wordId: string;
  readonly text: string;
  readonly replacement: string;
}

/** Builds a matcher once so scanning 54,000 words does not recompile a regex per word. */
function buildMatcher(
  query: string,
  options: FindOptions,
): ((text: string) => boolean) | undefined {
  if (query === "") return undefined;
  if (options.regex === true) {
    try {
      const pattern = new RegExp(query, options.caseSensitive === true ? "" : "i");
      return (text) => pattern.test(text);
    } catch {
      return undefined;
    }
  }
  const needle = options.caseSensitive === true ? query : query.toLowerCase();
  if (options.wholeWord === true) {
    return (text) => (options.caseSensitive === true ? text : text.toLowerCase()) === needle;
  }
  return (text) => (options.caseSensitive === true ? text : text.toLowerCase()).includes(needle);
}

/** Every live word (in the given display script) whose text matches `query`. */
export function findMatches(
  words: readonly Word[],
  query: string,
  script: "roman" | "native" | "en",
  options: FindOptions = {},
): WordMatch[] {
  const matcher = buildMatcher(query, options);
  if (matcher === undefined) return [];
  const matches: WordMatch[] = [];
  for (const word of words) {
    if (word.deleted === true) continue;
    const text = word.scripts?.[script] ?? word.t;
    if (matcher(text)) matches.push({ wordId: word.wid, text, replacement: text });
  }
  return matches;
}

/**
 * "Replace all": every match's replacement is `replacement`, whole-word (a
 * find/replace on connected text still operates one word at a time, since
 * `EditWord` is word-addressed, CONTRACTS §2).
 */
export function replaceAll(matches: readonly WordMatch[], replacement: string): WordMatch[] {
  return matches.map((match) => ({ ...match, replacement }));
}

/** Every live word spelled exactly like `word` (case-sensitive, whole word) — "Fix spelling everywhere". */
export function findSameSpelling(
  words: readonly Word[],
  word: string,
  script: "roman" | "native" | "en",
): WordMatch[] {
  return findMatches(words, word, script, { caseSensitive: true, wholeWord: true });
}
