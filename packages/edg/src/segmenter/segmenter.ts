import { newId as defaultNewId } from "../ids.js";
import { type Segment } from "../schemas/segment.js";
import { type Word } from "../schemas/transcript.js";
import { seqSequence } from "../seq.js";
import { charCount, dominantScript, limitsFor, type WordScript } from "./script.js";

/**
 * Caption segmentation (09 §3). Deterministic by construction: one left-to-right
 * greedy pass over the live words, then one merge pass that absorbs runs below
 * the minimum duration, then one rebalancing pass that clears the widows a
 * forced break leaves behind. The same words and parameters always produce the
 * same segments — only the ids come from outside.
 *
 * A break is only ever placed **between** words. Where it may be placed:
 *
 * - **Hard** — the speaker changed.
 * - **Forced** — one more word would need another line, run past `maxMs`, or push
 *   the reading speed past the script's ceiling.
 * - **Preferred** — the previous word ended a sentence, or the pause before this
 *   word is at least `mergeGapMs`; shorter gaps are never break points, which is
 *   what "merge gaps < 150 ms" means.
 *
 * Preferred breaks only fire once the pending segment has reached `minMs`, so the
 * segmenter never manufactures a caption too short to read.
 *
 * A **forced** break can still leave the next caption holding a single word. The
 * last pass ({@link rebalanceOrphans}) hands that caption the previous one's last
 * word wherever both halves still fit — a hard or preferred break is left alone,
 * because a one-word caption after a full stop is the speaker's, not the
 * arithmetic's.
 */

/** Segmentation limits. `undefined` means "use the per-script table" (09 §3). */
export interface SegmenterParams {
  /** Characters per line; overrides the script's own limit when set. */
  maxChars?: number;
  /** Lines a caption may occupy. */
  maxLines: number;
  /** Shortest caption, in ms. */
  minMs: number;
  /** Longest caption, in ms. */
  maxMs: number;
  /** Reading-speed ceiling in characters per second; overrides the script's own. */
  maxCps?: number;
  /** The shortest pause that counts as a break point; shorter gaps are merged. */
  mergeGapMs: number;
  /** Break when the speaker id changes. */
  breakOnSpeakerChange: boolean;
  /** Break after sentence-final punctuation. */
  breakOnSentenceEnd: boolean;
}

/** The defaults from `09-ai-pipeline.md` §3. */
export const DEFAULT_SEGMENTER_PARAMS: SegmenterParams = {
  maxLines: 2,
  minMs: 700,
  maxMs: 6000,
  mergeGapMs: 150,
  breakOnSpeakerChange: true,
  breakOnSentenceEnd: true,
};

export interface SegmenterOptions {
  /** Leave tagged filler words out of the captions. */
  dropFillers?: boolean;
  /** Id factory for the new segments; defaults to the process ULID factory. */
  newId?: () => string;
  /** `styleRef` stamped on every segment. */
  styleRef?: string;
}

/** Sentence-final punctuation, optionally followed by a closing quote or bracket. */
const SENTENCE_END = /[.!?…।॥]["'”’)\]]*$/u;

interface Prepared {
  readonly word: Word;
  readonly chars: number;
  readonly endsSentence: boolean;
}

interface Pending {
  words: Prepared[];
  /**
   * The run was opened because the previous caption could not take the word —
   * a line, duration or reading-speed limit, not a speaker change and not a
   * preferred break. Only these runs are rebalanced ({@link rebalanceOrphans}).
   */
  forced: boolean;
  /** Rendered length including the spaces between words. */
  chars: number;
  /** Lines used by a greedy wrap at `maxCharsPerLine`. */
  lines: number;
  /** Characters already on the last line. */
  lineChars: number;
  startMs: number;
  endMs: number;
}

function prepare(words: readonly Word[], dropFillers: boolean): Prepared[] {
  const prepared: Prepared[] = [];
  for (const word of words) {
    if (word.deleted === true) continue;
    if (dropFillers && word.filler === true) continue;
    prepared.push({ word, chars: charCount(word.t), endsSentence: SENTENCE_END.test(word.t) });
  }
  return prepared;
}

function open(entry: Prepared, forced: boolean): Pending {
  return {
    words: [entry],
    forced,
    chars: entry.chars,
    lines: 1,
    lineChars: entry.chars,
    startMs: entry.word.s,
    endMs: entry.word.e,
  };
}

function push(pending: Pending, entry: Prepared, maxCharsPerLine: number): void {
  const fitsOnLine = pending.lineChars + 1 + entry.chars <= maxCharsPerLine;
  pending.words.push(entry);
  pending.chars += 1 + entry.chars;
  pending.lines += fitsOnLine ? 0 : 1;
  pending.lineChars = fitsOnLine ? pending.lineChars + 1 + entry.chars : entry.chars;
  pending.endMs = entry.word.e;
}

/** Characters per second a caption asks the viewer to read. */
function cps(chars: number, durationMs: number): number {
  return durationMs <= 0 ? Number.POSITIVE_INFINITY : (chars * 1000) / durationMs;
}

interface Resolved {
  readonly maxCharsPerLine: number;
  readonly maxCps: number;
  readonly script: WordScript;
}

function resolveLimits(entries: readonly Prepared[], params: SegmenterParams): Resolved {
  const script = dominantScript(entries.map((entry) => entry.word.t));
  const limits = limitsFor(script);
  return {
    script,
    maxCharsPerLine: params.maxChars ?? limits.maxCharsPerLine,
    maxCps: params.maxCps ?? limits.maxCps,
  };
}

/** Would appending `entry` still respect every limit? */
function accepts(
  pending: Pending,
  entry: Prepared,
  params: SegmenterParams,
  limits: Resolved,
): boolean {
  const fitsOnLine = pending.lineChars + 1 + entry.chars <= limits.maxCharsPerLine;
  const lines = pending.lines + (fitsOnLine ? 0 : 1);
  const duration = entry.word.e - pending.startMs;
  const chars = pending.chars + 1 + entry.chars;
  const pendingDuration = pending.endMs - pending.startMs;
  return (
    lines <= params.maxLines &&
    duration <= params.maxMs &&
    (cps(chars, duration) <= limits.maxCps || pendingDuration < params.minMs)
  );
}

function toSegment(
  pending: Pending,
  seq: string,
  id: string,
  styleRef: string | undefined,
): Segment {
  const first = pending.words[0];
  const last = pending.words[pending.words.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("cannot build a segment from an empty word run");
  }
  const segment: Segment = {
    id,
    seq,
    startWordId: first.word.wid,
    endWordId: last.word.wid,
    startMs: first.word.s,
    endMs: last.word.e,
  };
  return styleRef === undefined ? segment : { ...segment, styleRef };
}

function joinIfPossible(
  left: Pending,
  right: Pending,
  params: SegmenterParams,
  limits: Resolved,
): Pending | undefined {
  const leftLast = left.words[left.words.length - 1];
  const rightFirst = right.words[0];
  if (leftLast === undefined || rightFirst === undefined) return undefined;
  if (params.breakOnSpeakerChange && leftLast.word.sp !== rightFirst.word.sp) return undefined;
  const candidate: Pending = {
    words: [...left.words],
    forced: left.forced,
    chars: left.chars,
    lines: left.lines,
    lineChars: left.lineChars,
    startMs: left.startMs,
    endMs: left.endMs,
  };
  for (const entry of right.words) {
    if (!accepts(candidate, entry, params, limits)) return undefined;
    push(candidate, entry, limits.maxCharsPerLine);
  }
  return candidate;
}

/**
 * Merges any run shorter than `minMs` into a neighbour that can still take it,
 * preferring the one before it. Left to right, one pass, so the result never
 * depends on where the scan started.
 */
function absorbShortRuns(runs: Pending[], params: SegmenterParams, limits: Resolved): Pending[] {
  const merged: Pending[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    const tooShort = run.endMs - run.startMs < params.minMs;
    if (!tooShort || previous === undefined) {
      merged.push(run);
      continue;
    }
    const joined = joinIfPossible(previous, run, params, limits);
    if (joined === undefined) merged.push(run);
    else merged[merged.length - 1] = joined;
  }
  // The first run has no predecessor, so it borrows the one that follows.
  const first = merged[0];
  const second = merged[1];
  if (first !== undefined && second !== undefined && first.endMs - first.startMs < params.minMs) {
    const joined = joinIfPossible(first, second, params, limits);
    if (joined !== undefined) merged.splice(0, 2, joined);
  }
  return merged;
}

/**
 * Rebuild a run from a word list, or `undefined` when the list does not fit the
 * limits. The same {@link accepts} rule as the forward pass, so a rebuilt run is
 * indistinguishable from one the greedy scan produced.
 */
function build(
  entries: readonly Prepared[],
  forced: boolean,
  params: SegmenterParams,
  limits: Resolved,
): Pending | undefined {
  const [head, ...rest] = entries;
  if (head === undefined) return undefined;
  const pending = open(head, forced);
  for (const entry of rest) {
    if (!accepts(pending, entry, params, limits)) return undefined;
    push(pending, entry, limits.maxCharsPerLine);
  }
  return pending;
}

/**
 * Widow and orphan rebalancing.
 *
 * A caption that had to break because one more word would not fit can leave the
 * next caption holding a single word — a caption that flashes one word on screen
 * and reads as a mistake rather than as a line. Where the caption before it can
 * give up its last word and both halves still satisfy every limit, it does, so
 * the pair reads as two lines rather than as a line and a stray.
 *
 * Only **forced** breaks are rebalanced. A speaker change is a hard boundary, and
 * a preferred break after a full stop or a long pause is a deliberate one-word
 * caption ("Bilkul.") that the speaker actually left alone.
 *
 * One left-to-right pass, one donated word per orphan, and every candidate is
 * rebuilt through {@link accepts} — so the result is deterministic and no
 * rebalanced caption can exceed a limit the greedy pass respected.
 */
function rebalanceOrphans(runs: Pending[], params: SegmenterParams, limits: Resolved): Pending[] {
  const balanced = [...runs];
  for (let index = 1; index < balanced.length; index += 1) {
    const orphan = balanced[index];
    const previous = balanced[index - 1];
    if (orphan === undefined || previous === undefined) continue;
    if (!orphan.forced || orphan.words.length !== 1) continue;
    if (previous.words.length < 2) continue;

    const donor = previous.words[previous.words.length - 1];
    const receiver = orphan.words[0];
    if (donor === undefined || receiver === undefined) continue;
    // The donated word must not cross a boundary the forward pass would have
    // broken on anyway: another speaker, or a sentence that ended on it.
    if (params.breakOnSpeakerChange && donor.word.sp !== receiver.word.sp) continue;
    if (params.breakOnSentenceEnd && donor.endsSentence) continue;

    const shortened = build(previous.words.slice(0, -1), previous.forced, params, limits);
    const widened = build([donor, receiver], orphan.forced, params, limits);
    if (shortened === undefined || widened === undefined) continue;
    // Donating must not manufacture the very thing `absorbShortRuns` removes.
    if (shortened.endMs - shortened.startMs < params.minMs) continue;

    balanced[index - 1] = shortened;
    balanced[index] = widened;
  }
  return balanced;
}

/**
 * Splits `words` into caption segments. Tombstoned words are always skipped;
 * fillers stay unless `opts.dropFillers` is set. Segment ids come from
 * `opts.newId` and `seq` keys from `seqSequence`; everything else is a pure
 * function of the words and the parameters.
 */
export function segmentWords(
  words: readonly Word[],
  params: Partial<SegmenterParams> = {},
  opts: SegmenterOptions = {},
): Segment[] {
  const resolvedParams: SegmenterParams = { ...DEFAULT_SEGMENTER_PARAMS, ...params };
  const entries = prepare(words, opts.dropFillers === true);
  if (entries.length === 0) return [];

  const limits = resolveLimits(entries, resolvedParams);
  const runs: Pending[] = [];
  let pending: Pending | undefined;
  let previous: Prepared | undefined;

  for (const entry of entries) {
    if (pending === undefined || previous === undefined) {
      pending = open(entry, false);
      previous = entry;
      continue;
    }
    const speakerChanged = entry.word.sp !== previous.word.sp;
    const gap = entry.word.s - previous.word.e;
    const pendingDuration = pending.endMs - pending.startMs;
    const preferred =
      pendingDuration >= resolvedParams.minMs &&
      ((resolvedParams.breakOnSentenceEnd && previous.endsSentence) ||
        gap >= resolvedParams.mergeGapMs);
    const hardBreak = resolvedParams.breakOnSpeakerChange && speakerChanged;
    // A limit the caption cannot stretch to hold: the only break the orphan pass
    // is allowed to undo, because nothing but arithmetic put it there.
    const forcedBreak = !hardBreak && !accepts(pending, entry, resolvedParams, limits);

    if (hardBreak || forcedBreak || preferred) {
      runs.push(pending);
      pending = open(entry, forcedBreak && !preferred);
    } else {
      push(pending, entry, limits.maxCharsPerLine);
    }
    previous = entry;
  }
  if (pending !== undefined) runs.push(pending);

  const absorbed = rebalanceOrphans(
    absorbShortRuns(runs, resolvedParams, limits),
    resolvedParams,
    limits,
  );
  const mint = opts.newId ?? defaultNewId;
  const keys = seqSequence(absorbed.length);
  return absorbed.map((run, index) => {
    const seq = keys[index];
    if (seq === undefined) throw new Error("seqSequence returned too few keys");
    return toSegment(run, seq, mint(), opts.styleRef);
  });
}

/**
 * The lines a caption would wrap to at `maxCharsPerLine`. The segmenter uses the
 * same greedy rule internally; this is the version tests and tooling can call.
 */
export function wrapLines(texts: readonly string[], maxCharsPerLine: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const text of texts) {
    if (current === "") {
      current = text;
      continue;
    }
    if (charCount(current) + 1 + charCount(text) <= maxCharsPerLine) current += ` ${text}`;
    else {
      lines.push(current);
      current = text;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** The script the segmenter would apply its limits from, for tests and tooling. */
export function segmentScript(words: readonly Word[]): WordScript {
  return dominantScript(words.map((word) => word.t));
}
