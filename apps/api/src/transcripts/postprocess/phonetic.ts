/**
 * A phonetic key for glossary matching, tuned for Indian names written in Roman
 * script.
 *
 * Soundex and Metaphone are built around English orthography and are actively
 * wrong here: they treat `ph`/`f`, `v`/`w` and `z`/`j` as different sounds when a
 * Hindi speaker's Roman spelling swaps them freely, and they keep vowels that
 * carry no information at all once a name has been through an ASR ("Aksharo",
 * "Akshero", "Achsharo"). What survives a transliteration is the **consonant
 * skeleton**, so that is the key.
 *
 * The rules, in order:
 *
 * 1. Devanagari and Tamil are reduced to their base consonants — matras, nuktas
 *    and viramas are marks on a consonant, not sounds of their own.
 * 2. Roman aspirates collapse onto their unaspirated consonant (`bh`→`b`,
 *    `kh`→`k`, `th`→`t`), because Roman Hindi spells aspiration inconsistently.
 * 3. Confusable pairs are merged: `f`↔`ph`, `v`↔`w`, `z`↔`j`, `c`↔`k`, `q`↔`k`,
 *    `x`→`ks`, `sh`/`ss`→`s`.
 * 4. Vowels are dropped except a leading one, which anchors the key.
 * 5. Doubled letters collapse.
 *
 * The key is a bucket, not a verdict: `glossary.ts` still requires an edit
 * distance of at most 2 before it rewrites a word.
 */

/** Combining marks: Devanagari matras, nuktas, viramas, Tamil vowel signs. */
const COMBINING = /\p{M}/gu;

const DIGRAPHS: readonly (readonly [RegExp, string])[] = [
  [/ph/g, "f"],
  [/sh/g, "s"],
  [/ss/g, "s"],
  [/ch/g, "c"],
  [/kh/g, "k"],
  [/gh/g, "g"],
  [/th/g, "t"],
  [/dh/g, "d"],
  [/bh/g, "b"],
  [/jh/g, "j"],
  [/zh/g, "j"],
  [/ck/g, "k"],
  [/x/g, "ks"],
];

const SINGLES: readonly (readonly [RegExp, string])[] = [
  [/[wv]/g, "v"],
  [/z/g, "j"],
  [/[qc]/g, "k"],
  [/f/g, "f"],
];

// ASCII vowels only: the NFD strip above has already removed every combining
// vowel sign, and a combining mark inside a character class is a lint error as
// well as a bug (it would only match the mark, never the cluster).
const VOWELS = /[aeiouy]/g;

/**
 * The phonetic key of one token, or `""` when it carries no letters.
 *
 * Deterministic and cheap: a glossary of a few hundred terms is keyed once per
 * transcription and the words are looked up in a map.
 */
export function phoneticKey(text: string): string {
  const bare = text
    .normalize("NFD")
    .replace(COMBINING, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  if (bare === "") return "";

  // Indic scripts are already a consonant skeleton once the marks are gone.
  if (/[ऀ-ॿ஀-௿ঀ-৿]/u.test(bare)) {
    return dedupe(bare);
  }

  let key = bare;
  for (const [pattern, replacement] of DIGRAPHS) key = key.replace(pattern, replacement);
  for (const [pattern, replacement] of SINGLES) key = key.replace(pattern, replacement);

  const leading = VOWELS.test(key[0] ?? "") ? (key[0] ?? "") : "";
  VOWELS.lastIndex = 0;
  const consonants = key.slice(leading.length).replace(VOWELS, "");
  VOWELS.lastIndex = 0;

  return dedupe(leading + consonants);
}

/** `bharatt` and `bharat` are the same name. */
function dedupe(text: string): string {
  let out = "";
  for (const character of text) {
    if (out.endsWith(character)) continue;
    out += character;
  }
  return out;
}

/**
 * Levenshtein distance, capped: anything past `limit` returns `limit + 1`
 * immediately, because the caller only ever asks "is this within 2?".
 */
export function editDistance(left: string, right: string, limit = Number.MAX_SAFE_INTEGER): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > limit) return limit + 1;

  const previous = new Array<number>(right.length + 1);
  const current = new Array<number>(right.length + 1);
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  for (let index = 0; index <= right.length; index += 1) previous[index] = index;

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    let best = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      const value = Math.min(
        (current[column - 1] ?? 0) + 1,
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) + substitution,
      );
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      current[column] = value;
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    for (let index = 0; index <= right.length; index += 1) previous[index] = current[index] ?? 0;
  }
  return previous[right.length] ?? 0;
}
