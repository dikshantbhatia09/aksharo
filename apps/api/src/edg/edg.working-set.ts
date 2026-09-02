import { type EdgOp } from "@montaj/edg/schemas";

/**
 * Which rows a batch can possibly touch.
 *
 * `appendRevision` must not load a 9,000-segment document to move one caption by
 * 40 ms, so it loads a **working set**: the rows the ops name, plus exactly the
 * neighbours the engine reaches for while applying them. This file is the
 * analysis half — pure, and unit-tested on its own; `edg.repository.ts` turns the
 * request into queries.
 *
 * The neighbours are not a heuristic. They are what `@montaj/edg/ops` reads:
 *
 * | The engine does this                                    | so the working set carries               |
 * | ------------------------------------------------------- | ---------------------------------------- |
 * | `SplitSegment` mints `seqBetween(seq, nextSeq)`         | the segment after the last one addressed |
 * | `MergeSegments` checks the ids are neighbours in `order` | every live segment between the addressed ones |
 * | `DeleteWord` shrinks the segments the word bounds       | segments whose `start/end_word_id` is that word |
 * | `positionOf` ranks words in document order              | the chunk of every word a loaded segment bounds |
 * | `wordAfter` / `previousLiveWord` cross chunk boundaries | one chunk either side of every chunk named |
 * | `Resegment` rebuilds the whole caption list             | **everything** — there is no partial form |
 *
 * A rule that cannot be met with a bounded read (`Resegment`) sets
 * {@link WorkingSetRequest.wholeDocument} instead of guessing, and the repository
 * loads the document. Anything else is a handful of rows whatever the document's
 * size, which is what keeps the p95 flat as a project grows.
 */

/** What one batch needs read before {@link import("@montaj/edg/ops").applyOps} can run. */
export interface WorkingSetRequest {
  /**
   * `true` when no bounded read is correct: a `Resegment` replaces every segment
   * and re-reads every live word, so a partial state would delete the captions it
   * could not see.
   */
  readonly wholeDocument: boolean;
  /** Segment ids the ops address (`newSegmentId`s are excluded — they do not exist yet). */
  readonly segmentIds: readonly string[];
  /** Word ids the ops address, including the anchors of an insert. */
  readonly wordIds: readonly string[];
  /** Word ids whose bounding segments must be loaded, whatever their `seq` (`DeleteWord`). */
  readonly boundaryWordIds: readonly string[];
  /**
   * Word ids `SetWordTiming` retimes. Unlike every other word op, this one carries
   * no `segmentId`, so the repository resolves the segment that currently
   * *contains* each word (not merely bounds it) from the word's own timing before
   * it loads segments — see `edg.repository.ts`'s `resolveTimingSegments`.
   */
  readonly timingWordIds: readonly string[];
  /** Pass item ids `DecideItems` names. */
  readonly itemIds: readonly string[];
  /** Passes named by a `MergePass`, whose existing items are replaced wholesale. */
  readonly passIds: readonly string[];
  /** `true` when the batch can change the transcript, so chunk rows may need writing back. */
  readonly touchesWords: boolean;
  /**
   * `true` when the engine will consult the transcript while applying the batch.
   *
   * Most edits do not: setting a caption's text, style, position or hidden flag
   * touches the segment row and nothing else, and loading a 10-minute chunk of
   * words to answer a question nobody asks is the single most expensive thing the
   * write path could do. The ops that DO need words are the ones that rank them —
   * `positionOf` for a bounds change or a split, the emphasis check, a merge's
   * outermost word, and every word op — plus `Resegment`, which re-reads all of
   * them.
   */
  readonly needsWords: boolean;
}

function push(into: Set<string>, value: string | undefined): void {
  if (value !== undefined) into.add(value);
}

/** Analyse a batch: what it names, and what the engine will reach for around it. */
export function analyseWorkingSet(ops: readonly EdgOp[]): WorkingSetRequest {
  const segmentIds = new Set<string>();
  const wordIds = new Set<string>();
  const boundaryWordIds = new Set<string>();
  const timingWordIds = new Set<string>();
  const itemIds = new Set<string>();
  const passIds = new Set<string>();
  let wholeDocument = false;
  let touchesWords = false;
  let needsWords = false;

  for (const op of ops) {
    switch (op.type) {
      case "SetSegmentText":
      case "SetSegmentPosition":
      case "HideSegment":
        segmentIds.add(op.segmentId);
        break;
      case "SetEmphasis":
        segmentIds.add(op.segmentId);
        wordIds.add(op.wordId);
        needsWords = true;
        break;
      case "SetSegmentBounds":
        segmentIds.add(op.segmentId);
        push(wordIds, op.startWordId);
        push(wordIds, op.endWordId);
        needsWords = true;
        break;
      case "SplitSegment":
        segmentIds.add(op.segmentId);
        wordIds.add(op.atWordId);
        needsWords = true;
        break;
      case "MergeSegments":
        for (const id of op.segmentIds) segmentIds.add(id);
        // `outermostWord` and `sortEmphasis` rank the merged words in document order.
        needsWords = true;
        break;
      case "SetStyle":
        push(segmentIds, op.segmentId);
        break;
      case "EditWord":
        wordIds.add(op.wordId);
        touchesWords = true;
        needsWords = true;
        break;
      case "DeleteWord":
        wordIds.add(op.wordId);
        boundaryWordIds.add(op.wordId);
        touchesWords = true;
        needsWords = true;
        break;
      case "InsertWordAfter":
        wordIds.add(op.wordId);
        wordIds.add(op.newWordId);
        touchesWords = true;
        needsWords = true;
        break;
      case "SetWordTiming":
        wordIds.add(op.wordId);
        timingWordIds.add(op.wordId);
        touchesWords = true;
        needsWords = true;
        break;
      case "Resegment":
        wholeDocument = true;
        break;
      case "DecideItems":
        for (const id of op.itemIds) itemIds.add(id);
        break;
      case "MergePass":
        passIds.add(op.pass.passId);
        break;
      case "SetAudio":
      case "SetRender":
        break;
    }
  }

  return {
    wholeDocument,
    segmentIds: [...segmentIds],
    wordIds: [...wordIds],
    boundaryWordIds: [...boundaryWordIds],
    timingWordIds: [...timingWordIds],
    itemIds: [...itemIds],
    passIds: [...passIds],
    touchesWords: touchesWords || wholeDocument,
    needsWords: needsWords || wholeDocument,
  };
}

/** `"<chunkIdx>:<n>"` → `chunkIdx`, or `undefined` when the id is malformed. */
export function chunkIndexOf(wordId: string): number | undefined {
  const raw = wordId.split(":")[0];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The chunk indices to read for a set of word ids: each word's own chunk and the
 * one either side of it.
 *
 * The neighbours are what make `wordAfter` and `previousLiveWord` answer the same
 * thing they would against the whole transcript. Deleting the last word of a
 * chunk asks for the first word of the next one, and an `InsertWordAfter` anchored
 * on it is range-checked against that word.
 */
export function chunkWindow(wordIds: Iterable<string>): number[] {
  const wanted = new Set<number>();
  for (const wordId of wordIds) {
    const idx = chunkIndexOf(wordId);
    if (idx === undefined) continue;
    // A chunk index the transcript does not have simply returns no row, so the
    // window is asked for directly rather than checked against a prior read.
    for (const candidate of [idx - 1, idx, idx + 1]) {
      if (candidate >= 0) wanted.add(candidate);
    }
  }
  return [...wanted].sort((a, b) => a - b);
}
