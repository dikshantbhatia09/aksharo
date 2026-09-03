/**
 * Builds the `ai.align` job payload (worker contract, `apps/worker-ai/
 * worker_ai/processors/align.py`: `{mediaId, language, segments: [{startMs,
 * endMs, text}]}`) from the project's *current* EDG document — the shared
 * step both replace-media re-alignment (B15 brief §5) and import-and-align
 * (§6, which instead builds segments from imported cues) need on the way in.
 *
 * Only non-deleted words count: a deleted word has no business being
 * re-aligned, and text built from it would ask the aligner to match audio for
 * a word nobody will see again.
 */

import type { Segment, Word, WordId } from "@montaj/edg/schemas";
import { wordsBetween } from "@montaj/render-core";
import type { TranscriptWord } from "@montaj/render-core";

export interface AlignSegmentPayload {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** One segment's word ids, in the same order as the text sent for it. */
export interface AlignSegmentWordIds {
  readonly segmentId: string;
  readonly wordIds: readonly WordId[];
}

export interface AlignPayloadBuild {
  readonly segments: readonly AlignSegmentPayload[];
  /** Parallel to `segments`. */
  readonly segmentWordIds: readonly AlignSegmentWordIds[];
}

/**
 * `edg.segments`, in `seq` order, each turned into `{startMs, endMs, text}`
 * plus the word ids the aligner's answer will map back onto — hidden segments
 * are skipped (nothing on screen to retime), and a segment with no live words
 * left contributes nothing.
 */
export function buildAlignPayload(
  segments: readonly Segment[],
  words: readonly Word[],
  segmentFilter: (segment: Segment) => boolean = () => true,
): AlignPayloadBuild {
  const built: AlignSegmentPayload[] = [];
  const segmentWordIds: AlignSegmentWordIds[] = [];

  const ordered = segments.filter((segment) => segment.hidden !== true && segmentFilter(segment));

  for (const segment of ordered) {
    const segmentWords = wordsBetween(
      words as unknown as readonly TranscriptWord[],
      segment.startWordId,
      segment.endWordId,
    ).filter((word) => word.deleted !== true);
    if (segmentWords.length === 0) continue;

    built.push({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segmentWords.map((word) => word.t).join(" "),
    });
    segmentWordIds.push({
      segmentId: segment.id,
      wordIds: segmentWords.map((word) => word.wid as WordId),
    });
  }

  return { segments: built, segmentWordIds };
}
