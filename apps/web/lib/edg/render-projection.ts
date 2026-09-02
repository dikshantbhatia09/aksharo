/**
 * `EdgState` (the store's own domain model, from `@montaj/edg/ops`) → the
 * render-focused `EdgProjection` `@montaj/render-core`'s `CaptionStage`,
 * `renderFrame` and `computeTrackShrink` take.
 *
 * The two `EdgProjection`s are not the same type on purpose: `@montaj/edg`'s
 * is the full editing document (segments, passes, meta); `@montaj/render-core`'s
 * (`packages/render-core/src/frame/projection.ts`) is only what a renderer
 * needs — canvas, styles, segments and the live word list flattened in reading
 * order. A15 owns the bridge because it is the first work package to hold both
 * shapes at once; A16 built the renderer half against the narrower type by
 * design (it must also run in a worker that never sees an `EdgState`).
 */
import { liveWords, orderedSegments } from "@montaj/edg";
import type { EdgState } from "@montaj/edg";
import type { EdgProjection, ProjectedSegment, TranscriptWord } from "@montaj/render-core";

export function toRenderProjection(state: EdgState): EdgProjection {
  const segments: ProjectedSegment[] = orderedSegments(state).map((segment) => ({
    id: segment.id,
    seq: segment.seq,
    startWordId: segment.startWordId,
    endWordId: segment.endWordId,
    startMs: segment.startMs,
    endMs: segment.endMs,
    ...(segment.styleRef === undefined ? {} : { styleRef: segment.styleRef }),
    ...(segment.overrides === undefined ? {} : { overrides: segment.overrides }),
    ...(segment.textOverrides === undefined ? {} : { textOverrides: segment.textOverrides }),
    ...(segment.emphasis === undefined ? {} : { emphasis: segment.emphasis }),
    ...(segment.position === undefined ? {} : { position: segment.position }),
    ...(segment.hidden === true ? { hidden: true } : {}),
  }));

  const words: TranscriptWord[] = liveWords(state).map((word) => ({
    wid: word.wid,
    s: word.s,
    e: word.e,
    t: word.t,
    ...(word.sp === undefined ? {} : { sp: word.sp }),
    ...(word.scripts === undefined ? {} : { scripts: word.scripts }),
    ...(word.filler === true ? { filler: true } : {}),
  }));

  return {
    canvas: state.hot.canvas,
    styles: state.hot.styles,
    ...(state.hot.render === undefined ? {} : { render: state.hot.render }),
    segments,
    words,
  };
}
