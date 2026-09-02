/**
 * The read model the renderer is handed.
 *
 * Deliberately not `EdgHot`: a render worker is given a projection, not a
 * database connection. Kept in its own module because both `renderFrame` and
 * `computeTrackShrink` need it, and a shared parent is cheaper than a cycle.
 */

import { type RenderSegment } from "../layout/types.js";
import { type CanvasSize } from "../units.js";
import { type StyleOverrides, type TranscriptWord } from "./resolve.js";

/** A segment as the projection hands it over (CONTRACTS §2 plus the ordering key). */
export interface ProjectedSegment extends RenderSegment {
  /** Fractional index; segments are drawn in this order. */
  readonly seq: string;
  readonly startWordId: string;
  readonly endWordId: string;
  readonly styleRef?: string;
  readonly overrides?: StyleOverrides;
  readonly textOverrides?: Record<string, string>;
  readonly emphasis?: readonly { readonly wordId: string; readonly presetId: string }[];
}

/**
 * The read model `renderFrame` needs: the hot document's style and canvas
 * fields, the segment rows and the transcript words in reading order. It is
 * deliberately not `EdgHot` — the renderer must run in a worker that was handed
 * a projection, not a database.
 */
export interface EdgProjection {
  readonly canvas: CanvasSize;
  readonly styles: {
    readonly defaultStyleId: string;
    /** Document-level `SetStyle` overrides live at `styles.inline.doc`. */
    readonly inline?: { readonly doc?: StyleOverrides } & Record<string, unknown>;
  };
  readonly render?: {
    /** Asset id of the watermark to burn in; absent means no watermark. */
    readonly watermarkAssetId?: string;
    readonly [key: string]: unknown;
  };
  readonly segments: readonly ProjectedSegment[];
  /** Every live word, in reading order. */
  readonly words: readonly TranscriptWord[];
  /** Per-speaker caption colours, for the podcast styles. */
  readonly speakerColours?: Readonly<Record<string, string>>;
}

/** The slice of the word list a segment covers, inclusive of both ends. */
export function wordsBetween(
  words: readonly TranscriptWord[],
  startWordId: string,
  endWordId: string,
): TranscriptWord[] {
  const start = words.findIndex((word) => word.wid === startWordId);
  if (start < 0) return [];
  const end = words.findIndex((word, index) => index >= start && word.wid === endWordId);
  return words.slice(start, end < 0 ? words.length : end + 1);
}

/** Segments on screen at `sourceMs`, in `seq` order, hidden ones dropped. */
export function visibleSegments(
  segments: readonly ProjectedSegment[],
  sourceMs: number,
): ProjectedSegment[] {
  return segments
    .filter(
      (segment) =>
        segment.hidden !== true && sourceMs >= segment.startMs && sourceMs < segment.endMs,
    )
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : a.id.localeCompare(b.id)));
}
