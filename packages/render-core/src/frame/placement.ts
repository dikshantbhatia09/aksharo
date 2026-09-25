/**
 * Face-aware caption placement: keep a caption off the faces on screen while
 * it is up.
 *
 * The input is the face track `ai.faces` writes for a video (`faces.json`: face
 * boxes a few times a second, normalised to the source frame). The output is,
 * per caption, a position and a size that clear every face seen during that
 * caption — computed once per caption, so a caption never jumps while it is on
 * screen, and computed at render time, so it stays right after a split, a
 * merge, a reflow or a style change without rewriting the document.
 *
 * Rules, in order:
 *
 * 1. A caption the user positioned (`segment.position`) is never moved.
 * 2. A caption already clear of every face stays exactly where its style puts it.
 * 3. Otherwise it moves, as little as possible, into the free band below the
 *    faces; failing that, the band above them — at full size.
 * 4. If neither band holds it at full size, it shrinks (down to
 *    `MIN_PLACEMENT_SCALE`) into whichever band is larger.
 *
 * Pure: the same projection, track and instant give the same pixels in the
 * editor, the browser export and the cloud renderer.
 */

import { type StyleDoc } from "@montaj/caption-styles";

import { type Rect } from "../commands/types.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { layoutSegment } from "../layout/layout.js";
import { type Layout, type RenderSegment, type RenderWord } from "../layout/types.js";
import { type WordScript } from "../script.js";
import { type CanvasSize, ofCanvasShortSide } from "../units.js";

/** `faces.json` version this module reads; any other version is ignored. */
export const FACE_TRACK_VERSION = 1;

/** The smallest a caption is scaled to make room; below this it stops being legible. */
export const MIN_PLACEMENT_SCALE = 0.6;

/** A face is padded before it is avoided: hair above, a gap under the chin, a little either side. */
const PAD_ABOVE = 0.35;
const PAD_BELOW = 0.05;
const PAD_SIDES = 0.06;

/** Air between a face and the caption moved off it, as a share of the canvas height. */
const GAP = 0.015;

/** Faces shorter than this share of the frame are background, not the subject. */
const MIN_FACE_HEIGHT = 0.06;

/** `faces.json` as the worker writes it (`worker_ai/passes/faces.py`). */
export interface FaceTrackDocument {
  readonly version: number;
  readonly intervalMs: number;
  readonly source: { readonly width: number; readonly height: number };
  /** `[tMs, [[x, y, w, h], ...]]`, normalised to the source frame. */
  readonly samples: readonly (readonly [number, readonly (readonly number[])[]])[];
}

/**
 * The track mapped onto the output canvas: boxes as `[left, top, right, bottom]`
 * fractions of the canvas, so one track serves any preview size.
 */
export interface CanvasFaceTrack {
  readonly intervalMs: number;
  readonly times: readonly number[];
  readonly boxes: readonly (readonly Rect[])[];
}

/** A caption's placement: where its anchor goes, and how much smaller it is drawn. */
export interface Placement {
  readonly position: { readonly x: number; readonly y: number; readonly anchor: string };
  /** The shrink to draw at (a `shrinkOverride`); absent means the caption's own. */
  readonly shrink?: number;
}

/** Parses `faces.json`, or `undefined` when it is not a version this renderer reads. */
export function parseFaceTrack(value: unknown): FaceTrackDocument | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const doc = value as Partial<FaceTrackDocument>;
  if (doc.version !== FACE_TRACK_VERSION) return undefined;
  if (typeof doc.intervalMs !== "number" || doc.intervalMs <= 0) return undefined;
  const source = doc.source;
  if (source === undefined || !(source.width > 0) || !(source.height > 0)) return undefined;
  if (!Array.isArray(doc.samples)) return undefined;
  return doc as FaceTrackDocument;
}

/**
 * Maps a source-frame track onto a canvas the video is **cover**-fitted into —
 * scaled until it covers both axes, centred, cropped — which is how the editor
 * stage and both exporters draw the source (`coverScaleCrop`). Background-sized
 * faces and faces cropped entirely off the canvas are dropped.
 */
export function faceTrackOnCanvas(doc: FaceTrackDocument, canvas: CanvasSize): CanvasFaceTrack {
  const scale = Math.max(canvas.width / doc.source.width, canvas.height / doc.source.height);
  const shownW = (doc.source.width * scale) / canvas.width;
  const shownH = (doc.source.height * scale) / canvas.height;
  const offsetX = (1 - shownW) / 2;
  const offsetY = (1 - shownH) / 2;

  const times: number[] = [];
  const boxes: Rect[][] = [];
  for (const sample of doc.samples) {
    const [tMs, faces] = sample;
    const onCanvas: Rect[] = [];
    for (const face of faces) {
      const [x = 0, y = 0, w = 0, h = 0] = face;
      const box: Rect = [
        offsetX + x * shownW,
        offsetY + y * shownH,
        offsetX + (x + w) * shownW,
        offsetY + (y + h) * shownH,
      ];
      if (box[3] - box[1] < MIN_FACE_HEIGHT) continue;
      if (box[2] <= 0 || box[0] >= 1 || box[3] <= 0 || box[1] >= 1) continue;
      onCanvas.push(box);
    }
    times.push(tMs);
    boxes.push(onCanvas);
  }
  return { intervalMs: doc.intervalMs, times, boxes };
}

/**
 * Every face on screen during `[startMs, endMs)`, padded, in canvas pixels.
 * Samples just either side count too: a sample stands for its whole interval.
 */
export function facesDuring(
  track: CanvasFaceTrack,
  startMs: number,
  endMs: number,
  canvas: CanvasSize,
): Rect[] {
  const from = startMs - track.intervalMs;
  const to = endMs + track.intervalMs;
  const found: Rect[] = [];
  for (let index = firstAtOrAfter(track.times, from); index < track.times.length; index += 1) {
    // eslint-disable-next-line security/detect-object-injection -- numeric index into an internal array
    const t = track.times[index] as number;
    if (t > to) break;
    // eslint-disable-next-line security/detect-object-injection -- numeric index into an internal array
    for (const [left, top, right, bottom] of track.boxes[index] ?? []) {
      const w = right - left;
      const h = bottom - top;
      found.push([
        Math.max(0, left - w * PAD_SIDES) * canvas.width,
        Math.max(0, top - h * PAD_ABOVE) * canvas.height,
        Math.min(1, right + w * PAD_SIDES) * canvas.width,
        Math.min(1, bottom + h * PAD_BELOW) * canvas.height,
      ]);
    }
  }
  return found;
}

function firstAtOrAfter(times: readonly number[], value: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    // eslint-disable-next-line security/detect-object-injection -- numeric index into an internal array
    if ((times[mid] as number) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function union(a: Rect | undefined, b: Rect): Rect {
  if (a === undefined) return b;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** The ink a layout draws: its padded box and every word's box (motion styles move words). */
function extentOf(layout: Layout): Rect {
  let box: Rect = layout.paddedBox;
  for (const word of layout.words) box = union(box, word.box);
  return box;
}

export interface PlacementInput {
  readonly style: StyleDoc;
  readonly segment: RenderSegment;
  readonly words: readonly RenderWord[];
  readonly canvas: CanvasSize;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  readonly faces: CanvasFaceTrack;
  readonly shrinkOverride?: (script: WordScript) => number | undefined;
}

/**
 * Where to put one caption so it clears the faces, or `undefined` to leave it
 * where its style puts it.
 */
export function placeCaption(input: PlacementInput): Placement | undefined {
  const { style, segment, words, canvas } = input;
  if (segment.position !== undefined || words.length === 0) return undefined;
  const faces = facesDuring(input.faces, segment.startMs, segment.endMs, canvas);
  if (faces.length === 0) return undefined;

  // The caption's full extent over its life: every word chunk it shows in turn,
  // and the smallest shrink any chunk needed to fit its width.
  const layoutAt = (
    shrink: number | undefined,
  ): { extent: Rect; shrink: number } | undefined => {
    let extent: Rect | undefined;
    let smallest = 1;
    const seen = new Set<number>();
    for (const word of words) {
      const at = Math.max(segment.startMs, word.s);
      if (seen.has(at)) continue;
      seen.add(at);
      const layout = layoutSegment({
        style,
        segment,
        words,
        canvas,
        registry: input.registry,
        shaper: input.shaper,
        tMs: at,
        shrinkOverride: (script) => combineShrink(input.shrinkOverride?.(script), shrink),
      });
      extent = union(extent, extentOf(layout));
      smallest = Math.min(smallest, layout.shrink);
    }
    return extent === undefined ? undefined : { extent, shrink: smallest };
  };

  const measured = layoutAt(undefined);
  if (measured === undefined) return undefined;
  const natural = measured.extent;
  const blocking = faces.filter((face) => face[0] < natural[2] && natural[0] < face[2]);
  if (!blocking.some((face) => overlaps(face, natural))) return undefined;

  const margin = ofCanvasShortSide(style.layout.safeAreaPct ?? 0, canvas);
  const facesTop = Math.min(...blocking.map((face) => face[1]));
  const facesBottom = Math.max(...blocking.map((face) => face[3]));
  const gap = GAP * canvas.height;
  const below = { top: facesBottom + gap, bottom: canvas.height - margin };
  const above = { top: margin, bottom: facesTop - gap };
  const room = (band: { top: number; bottom: number }): number => band.bottom - band.top;

  const anchor = style.layout.anchor;
  const anchorX = style.layout.x;
  const anchorY = style.layout.y;
  const naturalHeight = natural[3] - natural[1];

  /** Moves a caption of `extent` into `band` by the least distance. */
  const into = (band: { top: number; bottom: number }, extent: Rect): Placement["position"] => {
    const height = extent[3] - extent[1];
    const top = Math.min(Math.max(extent[1], band.top), Math.max(band.top, band.bottom - height));
    return { x: anchorX, y: anchorY + (top - extent[1]) / canvas.height, anchor };
  };

  if (room(below) >= naturalHeight) return { position: into(below, natural) };
  if (room(above) >= naturalHeight) return { position: into(above, natural) };

  const band = room(below) >= room(above) ? below : above;
  const scale = Math.max(MIN_PLACEMENT_SCALE, Math.min(1, room(band) / naturalHeight));
  const shrink = measured.shrink * scale;
  const shrunk = layoutAt(shrink)?.extent ?? natural;
  return { position: into(band, shrunk), shrink };
}

/** A placement's shrink combined with the track's: the smaller wins, as in `layoutSegment`. */
export function combineShrink(
  track: number | undefined,
  placement: number | undefined,
): number | undefined {
  if (placement === undefined) return track;
  return track === undefined ? placement : Math.min(track, placement);
}

/**
 * Placements are computed once per caption and reused for every frame it is on
 * screen. Keyed by the resolved style object (a new object whenever the style
 * changes) and by what the caption shows.
 */
export class PlacementCache {
  readonly #byStyle = new WeakMap<StyleDoc, Map<string, Placement | null>>();

  get(
    style: StyleDoc,
    key: string,
    compute: () => Placement | undefined,
  ): Placement | undefined {
    let entries = this.#byStyle.get(style);
    if (entries === undefined) {
      entries = new Map();
      this.#byStyle.set(style, entries);
    }
    const cached = entries.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const placement = compute();
    entries.set(key, placement ?? null);
    return placement;
  }
}

/** What a placement depends on besides the style: the caption, its words, the canvas. */
export function placementKey(
  segment: RenderSegment,
  words: readonly RenderWord[],
  canvas: CanvasSize,
  track: CanvasFaceTrack,
): string {
  return [
    segment.id,
    segment.startMs,
    segment.endMs,
    canvas.width,
    canvas.height,
    track.times.length,
    words.map((word) => `${word.wid}:${word.t}:${word.s}`).join("|"),
  ].join("/");
}
