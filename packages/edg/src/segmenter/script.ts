/**
 * Script detection and the per-script caption limits from `09-ai-pipeline.md` §3:
 * Latin 32 characters a line, Devanagari 24, Tamil 22, anything else 26, with a
 * reading-speed ceiling of 20 characters a second for Latin and 15 for Indic.
 *
 * Detection is by Unicode block, not by language tag: a Hinglish transcript mixes
 * Roman and Devanagari words inside one sentence, and the limit that matters is
 * the one for the script actually on screen.
 */

/** The script classes the segmenter distinguishes. */
export type WordScript = "latin" | "devanagari" | "tamil" | "other";

/** Ranking used to break a tie when a word mixes scripts evenly. */
const SCRIPT_PRIORITY: readonly WordScript[] = ["devanagari", "tamil", "latin", "other"];

interface Range {
  readonly from: number;
  readonly to: number;
}

const LATIN_RANGES: readonly Range[] = [
  { from: 0x0041, to: 0x005a }, // A-Z
  { from: 0x0061, to: 0x007a }, // a-z
  { from: 0x00c0, to: 0x024f }, // Latin-1 Supplement letters, Extended-A and -B
];

const DEVANAGARI_RANGES: readonly Range[] = [
  { from: 0x0900, to: 0x097f },
  { from: 0xa8e0, to: 0xa8ff }, // Devanagari Extended
];

const TAMIL_RANGES: readonly Range[] = [
  { from: 0x0b80, to: 0x0bff },
  { from: 0x11fc0, to: 0x11fff }, // Tamil Supplement
];

/**
 * Indic blocks other than Devanagari and Tamil. They share Devanagari's reading
 * speed but keep the neutral 26-character line, which is what "others" means in
 * the pipeline table.
 */
const OTHER_INDIC_RANGES: readonly Range[] = [
  { from: 0x0980, to: 0x09ff }, // Bengali / Assamese
  { from: 0x0a00, to: 0x0a7f }, // Gurmukhi
  { from: 0x0a80, to: 0x0aff }, // Gujarati
  { from: 0x0b00, to: 0x0b7f }, // Odia
  { from: 0x0c00, to: 0x0c7f }, // Telugu
  { from: 0x0c80, to: 0x0cff }, // Kannada
  { from: 0x0d00, to: 0x0d7f }, // Malayalam
  { from: 0x0d80, to: 0x0dff }, // Sinhala
];

function inRanges(code: number, ranges: readonly Range[]): boolean {
  for (const range of ranges) {
    if (code >= range.from && code <= range.to) return true;
  }
  return false;
}

/** Combining marks: vowel signs, nuktas, viramas — they render inside a cluster. */
const COMBINING_MARK = /\p{M}/u;

/**
 * Characters a line-length budget is spent on: code points minus combining
 * marks. For Latin that is the character count; for Indic scripts it counts
 * grapheme clusters, because the vowel signs and viramas that would inflate a
 * naive `text.length` occupy no width of their own.
 */
export function charCount(text: string): number {
  let count = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    // Nothing below U+0300 is a combining mark, so Latin never pays for the test.
    if (code < 0x0300 || !COMBINING_MARK.test(character)) count += 1;
  }
  return count;
}

/**
 * The script of one word, or `undefined` when it carries no letters at all
 * (digits, punctuation, an emoji) — those words do not get a vote.
 */
export function detectWordScript(text: string): WordScript | undefined {
  let latin = 0;
  let devanagari = 0;
  let tamil = 0;
  let other = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (inRanges(code, LATIN_RANGES)) latin += 1;
    else if (inRanges(code, DEVANAGARI_RANGES)) devanagari += 1;
    else if (inRanges(code, TAMIL_RANGES)) tamil += 1;
    else if (inRanges(code, OTHER_INDIC_RANGES)) other += 1;
    else if (code > 0x02ff && !COMBINING_MARK.test(character)) other += 1;
  }
  const counts: Record<WordScript, number> = { latin, devanagari, tamil, other };
  let best: WordScript | undefined;
  for (const script of SCRIPT_PRIORITY) {
    const count = counts[script];
    if (count === 0) continue;
    if (best === undefined || count > counts[best]) best = script;
  }
  return best;
}

/**
 * The script a run of words is written in: the one most of its letters belong
 * to. An empty or letterless run is treated as Latin, which is the widest line
 * budget and the one Roman Hinglish uses.
 */
export function dominantScript(texts: Iterable<string>): WordScript {
  const counts: Record<WordScript, number> = { latin: 0, devanagari: 0, tamil: 0, other: 0 };
  for (const text of texts) {
    const script = detectWordScript(text);
    if (script !== undefined) counts[script] += 1;
  }
  let best: WordScript = "latin";
  let bestCount = 0;
  for (const script of SCRIPT_PRIORITY) {
    if (counts[script] > bestCount) {
      best = script;
      bestCount = counts[script];
    }
  }
  return best;
}

/** Line length and reading speed per script (09 §3). */
export interface ScriptLimits {
  /** Characters that fit on one caption line. */
  readonly maxCharsPerLine: number;
  /** Reading-speed ceiling in characters per second. */
  readonly maxCps: number;
}

/** The frozen limit table (09 §3). */
export const SCRIPT_LIMITS: Readonly<Record<WordScript, ScriptLimits>> = {
  latin: { maxCharsPerLine: 32, maxCps: 20 },
  devanagari: { maxCharsPerLine: 24, maxCps: 15 },
  tamil: { maxCharsPerLine: 22, maxCps: 15 },
  other: { maxCharsPerLine: 26, maxCps: 15 },
};

/** The limits for one script. */
export function limitsFor(script: WordScript): ScriptLimits {
  return SCRIPT_LIMITS[script];
}
