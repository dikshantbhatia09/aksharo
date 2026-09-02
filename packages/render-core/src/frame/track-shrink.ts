/**
 * Track-level shrink.
 *
 * Shrink-to-fit is decided per caption, which is correct in isolation and wrong
 * in aggregate: a short caption is drawn at full size and the next one, one word
 * longer, is drawn smaller, so the type size jitters shot to shot through a
 * video. The fix is not to stop shrinking — a caption that overflows still has
 * to fit — but to shrink the whole **track** by the same amount.
 *
 * `computeTrackShrink` lays every caption out once and returns the minimum
 * shrink each (style, script) pair needs. `renderFrame` and `layoutFrame` take
 * that map and apply it uniformly, so every caption in a style is the same size
 * for the whole video. It is keyed by script as well as style because a Hinglish
 * project draws Latin and Devanagari captions at different sizes on purpose
 * (`typography.scriptScale`), and collapsing them would undo that.
 *
 * It is a pure function of its inputs and it is not cheap — one layout per
 * caption. Exporters (A19, A20) and the preview stage compute it **once per
 * session**, when the document or the canvas changes, and cache it; nothing
 * calls it per frame.
 */

import { type StyleDoc } from "@montaj/caption-styles";

import { type EdgProjection, wordsBetween } from "./projection.js";
import { type DisplayScript, resolveStyle, resolveWords } from "./resolve.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { layoutSegment } from "../layout/layout.js";
import { type WordScript } from "../script.js";
import { assertCanvas, type CanvasSize, q } from "../units.js";

/**
 * The minimum shrink per `styleId|script`. A `Map` rather than an object so the
 * key can carry a separator without quoting games, and so it is cheap to pass
 * to a worker.
 */
export type TrackShrink = ReadonlyMap<string, number>;

/** The key `TrackShrink` is stored under. Exported so a test can be explicit. */
export function trackShrinkKey(styleId: string, script: WordScript): string {
  return `${styleId}|${script}`;
}

export interface ComputeTrackShrinkOptions {
  readonly projection: EdgProjection;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  /** Defaults to the projection's own canvas. */
  readonly canvas?: CanvasSize;
  /** Which of a word's scripts to lay out; matches `renderFrame`. */
  readonly script?: DisplayScript;
  readonly dropFillers?: boolean;
}

/**
 * The smallest shrink each (style, script) pair needs across the whole track.
 *
 * A caption is measured at its own midpoint: that is where a `wordsPerCue` style
 * shows its middle chunk and where a `perWord` style shows a real word, so the
 * measurement reflects what is actually drawn rather than an entry animation.
 * Captions with no words contribute nothing.
 */
export function computeTrackShrink(options: ComputeTrackShrinkOptions): TrackShrink {
  const { projection, catalogue, registry, shaper } = options;
  const canvas = assertCanvas(options.canvas ?? projection.canvas);
  const source = {
    catalogue,
    defaultStyleId: projection.styles.defaultStyleId,
    ...(projection.styles.inline?.doc === undefined
      ? {}
      : { documentOverrides: projection.styles.inline.doc }),
  };
  const styleCache = new Map<string, StyleDoc>();
  const worst = new Map<string, number>();

  // `seq` order, so two runs over the same document visit the captions in the
  // same order and a float minimum is reduced identically.
  const segments = [...projection.segments]
    .filter((segment) => segment.hidden !== true)
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : a.id.localeCompare(b.id)));

  for (const segment of segments) {
    const style = resolveStyle(source, segment, styleCache);
    const words = resolveWords({
      segment,
      words: wordsBetween(projection.words, segment.startWordId, segment.endWordId),
      script: options.script ?? "roman",
      ...(options.dropFillers === undefined ? {} : { dropFillers: options.dropFillers }),
    });
    if (words.length === 0) continue;

    const layout = layoutSegment({
      style,
      segment,
      words,
      canvas,
      registry,
      shaper,
      tMs: segment.startMs + (segment.endMs - segment.startMs) / 2,
    });
    const key = trackShrinkKey(style.id, layout.script);
    const current = worst.get(key);
    if (current === undefined || layout.shrink < current) worst.set(key, q(layout.shrink));
  }

  return worst;
}

/** The shrink to apply to one caption, or `undefined` when the track has no opinion. */
export function trackShrinkFor(
  trackShrink: TrackShrink | undefined,
  styleId: string,
  script: WordScript,
): number | undefined {
  return trackShrink?.get(trackShrinkKey(styleId, script));
}
