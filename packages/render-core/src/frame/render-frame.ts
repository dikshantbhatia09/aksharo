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

import { type EdgProjection, visibleSegments, wordsBetween } from "./projection.js";
import { type DisplayScript, resolveStyle, resolveWords } from "./resolve.js";
import { type TrackShrink, trackShrinkFor } from "./track-shrink.js";
import { animate } from "../animate/animate.js";
import { type DrawCommand } from "../commands/types.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { layoutSegment } from "../layout/layout.js";
import { type Layout } from "../layout/types.js";
import { type CanvasSize, assertCanvas } from "../units.js";

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
  /**
   * One shrink per (style, script) for the whole caption track, from
   * `computeTrackShrink`. With it, every caption in a style is drawn at the same
   * size for the whole video; without it, each caption shrinks on its own.
   * Compute it once per session and cache it — it costs one layout per caption.
   */
  readonly trackShrink?: TrackShrink;
  /**
   * K07: overall opacity (`0`-`1`) of the whole caption overlay, passed
   * straight through to every visible segment's `animate()` call — see
   * `AnimateOptions.captionOpacity`'s doc comment for how it composites with
   * a cue's own fade in/out. `undefined` (every caller before this field
   * existed, including every fixture and golden-hash test) renders exactly
   * as before: `animate` defaults it to fully opaque.
   */
  readonly captionOpacity?: number;
}

/** The layouts that make up one frame; `renderFrame` is this plus `animate`. */
export function layoutFrame(options: RenderFrameOptions): { layout: Layout; style: StyleDoc }[] {
  const { projection, timemap, catalogue, registry, shaper } = options;
  const canvas = assertCanvas(options.canvas ?? projection.canvas);
  const sourceMs = timemap === null ? options.outputMs : timemap.toSource(options.outputMs);
  const source = {
    catalogue,
    defaultStyleId: projection.styles.defaultStyleId,
    ...(projection.styles.inline?.doc === undefined
      ? {}
      : { documentOverrides: projection.styles.inline.doc }),
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
      layout: layoutSegment({
        style,
        segment,
        words,
        canvas,
        registry,
        shaper,
        tMs: sourceMs,
        // Resolved after the layout knows which script it is drawing, because
        // the track keeps a separate size per script.
        shrinkOverride: (script) => trackShrinkFor(options.trackShrink, style.id, script),
      }),
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
        ...(projection.speakerColours === undefined
          ? {}
          : { speakerColours: projection.speakerColours }),
        ...(options.captionOpacity === undefined ? {} : { captionOpacity: options.captionOpacity }),
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
