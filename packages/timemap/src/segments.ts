import type { Segment, Word, WordId } from "@montaj/edg";

import type { OutputRange, TimeQuery } from "./query.js";

/**
 * The part of `Segment` this package reads (CONTRACTS §2). Derived from the
 * frozen type rather than restated, so a change there is a compile error here.
 */
export type SegmentTimes = Pick<Segment, "startMs" | "endMs" | "hidden">;

/** The part of `Word` this package reads (CONTRACTS §2). */
export type WordTimes = Pick<Word, "wid" | "s" | "e" | "deleted">;

/** A word after remapping. `ranges` is empty exactly when `hidden` is `true`. */
export interface MappedWord {
  readonly wid: WordId;
  /** `true` when nothing of the word survived the cuts. */
  readonly hidden: boolean;
  readonly ranges: readonly OutputRange[];
}

/** A caption segment after remapping. */
export interface MappedSegment {
  /**
   * `true` when the segment must not be drawn: it was hidden by its author, no
   * source time survived, or every live word landed inside a cut.
   */
  readonly hidden: boolean;
  /** The retained pieces of the segment, ordered; empty when `hidden`. */
  readonly visibleRanges: readonly OutputRange[];
  /** First output instant, or `null` when nothing survived. */
  readonly outputStartMs: number | null;
  /** Last output instant, or `null` when nothing survived. */
  readonly outputEndMs: number | null;
  /** Ids of the live words that fell entirely inside cuts. */
  readonly hiddenWords: readonly WordId[];
  /** Every live word, in the order given, with its output ranges. */
  readonly words: readonly MappedWord[];
}

/**
 * Remaps one word.
 *
 * A word is hidden when no retained source time is left in `[s, e)`. Zero-length
 * words (`e <= s`) are treated as the instant `s` and follow the `toOutput` rule:
 * hidden only strictly inside a cut.
 */
export function mapWord(map: TimeQuery, word: WordTimes): MappedWord {
  if (word.e <= word.s) {
    const outputMs = map.toOutput(word.s);
    if (outputMs === null) return { wid: word.wid, hidden: true, ranges: [] };
    return {
      wid: word.wid,
      hidden: false,
      ranges: [
        { sourceStart: word.s, sourceEnd: word.s, outputStart: outputMs, outputEnd: outputMs },
      ],
    };
  }
  const ranges = map.mapRange(word.s, word.e);
  return { wid: word.wid, hidden: ranges.length === 0, ranges };
}

/**
 * Remaps a caption segment and, when the transcript words are supplied, each of
 * its words.
 *
 * Tombstoned words (`deleted: true`) are ignored: they are not rendered, so they
 * cannot keep a segment alive. A segment whose live words all fall inside cuts is
 * hidden even if some of its span survived — the surviving span carries no text.
 */
export function mapSegment(
  map: TimeQuery,
  segment: SegmentTimes,
  words: readonly WordTimes[] = [],
): MappedSegment {
  const visibleRanges = map.mapRange(segment.startMs, segment.endMs);
  const live = words.filter((word) => word.deleted !== true);
  const mapped = live.map((word) => mapWord(map, word));
  const hiddenWords = mapped.filter((word) => word.hidden).map((word) => word.wid);

  const allWordsGone = mapped.length > 0 && hiddenWords.length === mapped.length;
  const hidden = segment.hidden === true || visibleRanges.length === 0 || allWordsGone;

  const first = visibleRanges[0];
  const last = visibleRanges[visibleRanges.length - 1];
  return {
    hidden,
    visibleRanges: hidden ? [] : visibleRanges,
    outputStartMs: hidden || !first ? null : first.outputStart,
    outputEndMs: hidden || !last ? null : last.outputEnd,
    hiddenWords,
    words: mapped,
  };
}
