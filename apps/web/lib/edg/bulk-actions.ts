/**
 * "Merge short" and "split long" (brief §3's bulk actions; the third,
 * auto-resegment, is `EditorStore.resegment` — server-minted, not built here).
 *
 * Both are plain functions from the current segment order to a batch of
 * ordinary ops (`MergeSegments`/`SplitSegment`), so they go through the same
 * queue, undo stack and conflict handling as a manual split or merge — a bulk
 * action is not a second write path, only a faster way to build one batch.
 */
import type { EdgOp, Segment, Word } from "@montaj/edg";

import { mergeSegments, splitSegment, type OpIdFactory } from "./ops";

/** Below this a caption reads as a stray fragment, not a line (mirrors `packages/edg`'s widow rebalance). */
export const DEFAULT_SHORT_MS = 900;

/** Above this a caption is doing two lines' worth of reading in one. */
export const DEFAULT_LONG_MS = 6_000;

export interface MergeShortInput {
  readonly segments: readonly Segment[];
  readonly thresholdMs?: number;
  readonly newId: OpIdFactory;
}

/**
 * One pass, left to right: a segment shorter than `thresholdMs` merges into
 * its next neighbour, then the pass continues past the merged pair — so a run
 * of three short captions in a row produces one merge, not two colliding
 * `MergeSegments` on the same id in one batch.
 */
export function planMergeShort(input: MergeShortInput): EdgOp[] {
  const threshold = input.thresholdMs ?? DEFAULT_SHORT_MS;
  const ops: EdgOp[] = [];
  let index = 0;
  while (index < input.segments.length - 1) {
    const current = input.segments[index];
    const next = input.segments[index + 1];
    if (current === undefined || next === undefined) break;
    const duration = current.endMs - current.startMs;
    if (duration < threshold && current.hidden !== true && next.hidden !== true) {
      ops.push(mergeSegments([current.id, next.id], current.id, input.newId));
      index += 2;
    } else {
      index += 1;
    }
  }
  return ops;
}

export interface SplitLongInput {
  readonly segments: readonly Segment[];
  readonly wordsOf: (segment: Segment) => readonly Word[];
  readonly thresholdMs?: number;
  readonly newId: OpIdFactory;
}

/** Splits a segment at the live word nearest its midpoint by time. */
function midpointWordId(segment: Segment, words: readonly Word[]): string | undefined {
  const live = words.filter((word) => word.deleted !== true);
  if (live.length < 2) return undefined;
  const midpoint = (segment.startMs + segment.endMs) / 2;
  let best = live[1];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const word of live.slice(1)) {
    const delta = Math.abs(word.s - midpoint);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = word;
    }
  }
  return best?.wid;
}

export function planSplitLong(input: SplitLongInput): EdgOp[] {
  const threshold = input.thresholdMs ?? DEFAULT_LONG_MS;
  const ops: EdgOp[] = [];
  for (const segment of input.segments) {
    if (segment.hidden === true) continue;
    if (segment.endMs - segment.startMs <= threshold) continue;
    const words = input.wordsOf(segment);
    const atWordId = midpointWordId(segment, words);
    if (atWordId === undefined) continue;
    ops.push(splitSegment(segment.id, atWordId, input.newId(), input.newId));
  }
  return ops;
}
