/**
 * `renderFrame` — one output millisecond of a project as `DrawCommand[]`.
 *
 * The output clock is the timeline's, the segments live on the source clock, so
 * the first thing that happens is `timemap.toSource(outputMs)` (decision D30).
 * Everything after that is the pure pipeline: resolve the style, resolve the
 * words, lay out, animate.
 *
 * Captions are emitted in `seq` order so two segments that overlap (a title over
 * a caption) stack the same way on every backend.
 */

import { type StyleDoc } from "@montaj/caption-styles";
import { type TimeQuery } from "@montaj/timemap";

import {
  type DisplayScript,
  resolveStyle,
  resolveWords,
  type StyleOverrides,
  type TranscriptWord,
} from "./resolve.js";
import { animate } from "../animate/animate.js";
import { type DrawCommand } from "../commands/types.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { layoutSegment } from "../layout/layout.js";
import { type Layout, type RenderSegment } from "../layout/types.js";
import { type CanvasSize, assertCanvas } from "../units.js";


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

export interface RenderFrameOptions {
  readonly projection: EdgProjection;
  /** `null` when the project has no edits: output time is source time. */
  readonly timemap: TimeQuery | null;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  /** Overrides the projection's canvas, e.g. to preview at the 540p proxy size. */
  readonly canvas?: CanvasSize;
  readonly outputMs: number;
  /** Which of a word's scripts to show; defaults to the transcript's own text. */
  readonly script?: DisplayScript;
  readonly dropFillers?: boolean;
  /** Re-used across frames so style merging is not redone thirty times a second. */
  readonly styleCache?: Map<string, StyleDoc>;
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
    .filter((segment) => segment.hidden !== true && sourceMs >= segment.startMs && sourceMs < segment.endMs)
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : a.id.localeCompare(b.id)));
}

/** The layouts that make up one frame; `renderFrame` is this plus `animate`. */
export function layoutFrame(options: RenderFrameOptions): { layout: Layout; style: StyleDoc }[] {
  const { projection, timemap, catalogue, registry, shaper } = options;
  const canvas = assertCanvas(options.canvas ?? projection.canvas);
  const sourceMs = timemap === null ? options.outputMs : timemap.toSource(options.outputMs);
  const source = {
    catalogue,
    defaultStyleId: projection.styles.defaultStyleId,
    ...(projection.styles.inline?.doc === undefined ? {} : { documentOverrides: projection.styles.inline.doc }),
  };

  const results: { layout: Layout; style: StyleDoc }[] = [];
  for (const segment of visibleSegments(projection.segments, sourceMs)) {
    const style = resolveStyle(source, segment, options.styleCache);
    const words = resolveWords({
      segment,
      words: wordsBetween(projection.words, segment.startWordId, segment.endWordId),
      script: options.script ?? "roman",
      ...(options.dropFillers === undefined ? {} : { dropFillers: options.dropFillers }),
    });
    if (words.length === 0) continue;
    results.push({
      style,
      layout: layoutSegment({ style, segment, words, canvas, registry, shaper, tMs: sourceMs }),
    });
  }
  return results;
}

export function renderFrame(options: RenderFrameOptions): DrawCommand[] {
  const { projection, timemap } = options;
  const sourceMs = timemap === null ? options.outputMs : timemap.toSource(options.outputMs);
  const watermarkAssetId = projection.render?.watermarkAssetId;

  const commands: DrawCommand[] = [];
  for (const { layout, style } of layoutFrame(options)) {
    commands.push(
      ...animate({
        layout,
        style,
        tMs: sourceMs,
        ...(projection.speakerColours === undefined ? {} : { speakerColours: projection.speakerColours }),
      }),
    );
  }
  if (watermarkAssetId !== undefined && commands.length >= 0) {
    const canvas = assertCanvas(options.canvas ?? projection.canvas);
    commands.push(watermarkFor(watermarkAssetId, canvas));
  }
  return commands;
}

/** The watermark rectangle, independent of whether any caption is on screen. */
export function watermarkFor(assetId: string, canvas: CanvasSize): DrawCommand {
  const width = canvas.width * 0.18;
  const height = width * 0.28;
  const margin = canvas.height * 0.03;
  return {
    kind: "image",
    assetId,
    dest: [
      canvas.width - margin - width,
      canvas.height - margin - height,
      canvas.width - margin,
      canvas.height - margin,
    ],
    opacity: 0.85,
  };
}
