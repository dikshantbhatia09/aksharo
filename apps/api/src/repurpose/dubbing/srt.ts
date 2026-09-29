import { makeWordId } from "@montaj/edg";
import type { Word } from "@montaj/edg/schemas";

/**
 * A dubbed clip's words, from the vendor's SRT (2026-10-04).
 *
 * The vendor times captions, not words: each cue says when a line of the dub is
 * spoken. The editor, the caption styles and the face-aware placement all work
 * on words, so each cue's words are spread across the cue by their length -
 * a long word gets more of the cue than a short one - which is what the
 * proportional aligner does for chunk-timed vendors (`ProportionalAligner` in
 * worker-ai). Length is counted without combining marks, the way the caption
 * budgets count Indic text (a matra does not make a word longer to say).
 *
 * Every word ends inside the picture: a cue past the dubbed video's end is
 * dropped and one running over it is cut, so a dub the vendor made longer than
 * the clip never puts captions over black.
 */

export interface SrtCue {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** `00:01:02,345 --> 00:01:04,000`, with `.` accepted for the comma (a WebVTT habit). */
const TIMING =
  /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/** The cues of an SRT file, in time order. Blocks that do not parse are skipped, not fatal. */
export function parseSrt(input: string): SrtCue[] {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const cues: SrtCue[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const at = lines.findIndex((line) => TIMING.test(line));
    if (at === -1) continue;
    const match = TIMING.exec(lines.at(at) ?? "");
    if (match === null) continue;
    const startMs = clock(match[1], match[2], match[3], match[4]);
    const endMs = clock(match[5], match[6], match[7], match[8]);
    const words = stripMarkup(lines.slice(at + 1).join(" "));
    if (words === "" || endMs <= startMs) continue;
    cues.push({ startMs, endMs, text: words });
  }
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/**
 * Words for a transcript chunk (chunk 0: a clip is one chunk), timed within
 * their cues and inside `[0, durationMs)`. Ids are `0:0`, `0:1`, ... in order.
 */
export function wordsFromCues(
  cues: readonly SrtCue[],
  options: { readonly durationMs: number },
): Word[] {
  const words: Word[] = [];
  let floor = 0;
  for (const cue of cues) {
    // An overlapping cue starts where the last one ended, so time never runs back.
    const start = Math.max(cue.startMs, floor);
    const end = Math.min(cue.endMs, options.durationMs);
    if (start >= end) continue;
    const tokens = tokensOf(cue.text);
    if (tokens.length === 0) continue;
    const weights = tokens.map(weightOf);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const span = end - start;
    let before = 0;
    let last = start;
    tokens.forEach((token, index) => {
      const s = Math.max(last, start + Math.round((span * before) / total));
      before += weights.at(index) ?? 1;
      const e = Math.max(s + 1, start + Math.round((span * before) / total));
      words.push({ wid: makeWordId(0, words.length), s, e, t: token });
      last = e;
    });
    floor = Math.max(end, last);
  }
  return words;
}

/** {@link parseSrt} then {@link wordsFromCues}. */
export function wordsFromSrt(input: string, options: { readonly durationMs: number }): Word[] {
  return wordsFromCues(parseSrt(input), options);
}

function clock(
  hours: string | undefined,
  minutes: string | undefined,
  seconds: string | undefined,
  fraction: string | undefined,
): number {
  return (
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1_000 +
    // `,5` is half a second, as `,500` is.
    Number((fraction ?? "0").padEnd(3, "0").slice(0, 3))
  );
}

/** Tags (`<i>`), ASS overrides (`{\an8}`) and runs of space out; the words stay. */
function stripMarkup(line: string): string {
  return line
    .replace(/<[^>]*>/g, " ")
    .replace(/\{\\[^}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The line's words, with a mark that stands alone (a danda, a dash) kept on the
 * word before it, so it is never a word of its own on a caption.
 */
function tokensOf(text: string): string[] {
  const tokens: string[] = [];
  for (const piece of text.split(/\s+/)) {
    if (piece === "") continue;
    const spoken = /[\p{L}\p{N}]/u.test(piece);
    const previous = tokens.length - 1;
    if (!spoken && previous >= 0) {
      tokens.splice(previous, 1, `${tokens.at(previous) ?? ""} ${piece}`);
    } else {
      tokens.push(piece);
    }
  }
  return tokens;
}

/** How long a word is to say, roughly: its characters without combining marks, at least one. */
function weightOf(token: string): number {
  const letters = [...token.normalize("NFC")].filter((ch) => !/\p{M}/u.test(ch)).length;
  return Math.max(1, letters);
}
