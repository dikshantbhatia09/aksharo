/**
 * The maths behind the caption stage, kept out of React so it can be tested
 * without a browser.
 *
 * Three jobs:
 *
 * 1. **Fit.** The project canvas (1080×1920, say) is letterboxed into whatever
 *    box the editor gives it; everything else works in project pixels and is
 *    scaled once, at the edge.
 * 2. **Drag.** A pointer drag on the caption box becomes a normalised
 *    `{ x, y, anchor }` — the shape `SetSegmentPosition` carries (CONTRACTS §2) —
 *    clamped so the box cannot be dropped outside the safe area.
 * 3. **Safe zones.** The rectangles the overlay draws so a creator can see where
 *    platform chrome will cover the caption.
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface StageFit {
  /** Size of the drawn canvas inside the container, in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Offset of the canvas inside the container (letterbox bars). */
  readonly left: number;
  readonly top: number;
  /** CSS pixels per project pixel. */
  readonly scale: number;
}

/** Letterboxes `canvas` inside `container`, preserving the aspect ratio. */
export function fitStage(container: Size, canvas: Size): StageFit {
  if (container.width <= 0 || container.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
    return { width: 0, height: 0, left: 0, top: 0, scale: 0 };
  }
  const scale = Math.min(container.width / canvas.width, container.height / canvas.height);
  const width = canvas.width * scale;
  const height = canvas.height * scale;
  return {
    width,
    height,
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    scale,
  };
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A pointer position in project pixels, given the stage element's own rect. */
export function toProjectPoint(client: Point, elementOrigin: Point, fit: StageFit): Point {
  if (fit.scale === 0) return { x: 0, y: 0 };
  return {
    x: (client.x - elementOrigin.x - fit.left) / fit.scale,
    y: (client.y - elementOrigin.y - fit.top) / fit.scale,
  };
}

export type Anchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** `[left, top, right, bottom]` in project pixels. */
export type Box = readonly [number, number, number, number];

const ANCHOR_FRACTIONS: Readonly<Record<Anchor, { readonly h: number; readonly v: number }>> = {
  "top-left": { h: 0, v: 0 },
  "top-center": { h: 0.5, v: 0 },
  "top-right": { h: 1, v: 0 },
  "middle-left": { h: 0, v: 0.5 },
  center: { h: 0.5, v: 0.5 },
  "middle-right": { h: 1, v: 0.5 },
  "bottom-left": { h: 0, v: 1 },
  "bottom-center": { h: 0.5, v: 1 },
  "bottom-right": { h: 1, v: 1 },
};

/** Where a box's anchor point sits, in project pixels. */
export function anchorPointOf(box: Box, anchor: Anchor): Point {
  const { h, v } = ANCHOR_FRACTIONS[anchor];
  return { x: box[0] + (box[2] - box[0]) * h, y: box[1] + (box[3] - box[1]) * v };
}

export interface SegmentPosition {
  readonly x: number;
  readonly y: number;
  readonly anchor: Anchor;
}

export interface DragOptions {
  /** The caption's box before the drag, in project pixels. */
  readonly box: Box;
  readonly canvas: Size;
  /** The style's anchor; a drag never changes which corner is addressed. */
  readonly anchor: Anchor;
  /** Safe-area margin as a percentage of the canvas **height**. */
  readonly safeAreaPct?: number;
}

/**
 * The position a drag of `(dx, dy)` project pixels produces.
 *
 * The box is clamped, not the anchor point: dragging a wide caption to the edge
 * should stop when its *edge* reaches the safe area, which is what a creator
 * expects and what the renderer will do anyway.
 */
export function positionFromDrag(delta: Point, options: DragOptions): SegmentPosition {
  const { box, canvas, anchor } = options;
  const margin = ((options.safeAreaPct ?? 0) / 100) * canvas.height;
  const width = box[2] - box[0];
  const height = box[3] - box[1];

  const minLeft = margin;
  const maxLeft = Math.max(minLeft, canvas.width - margin - width);
  const minTop = margin;
  const maxTop = Math.max(minTop, canvas.height - margin - height);

  const left = clamp(box[0] + delta.x, minLeft, maxLeft);
  const top = clamp(box[1] + delta.y, minTop, maxTop);
  const moved: Box = [left, top, left + width, top + height];
  const point = anchorPointOf(moved, anchor);

  return {
    x: round(clamp(point.x / canvas.width, 0, 1)),
    y: round(clamp(point.y / canvas.height, 0, 1)),
    anchor,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** Four decimals of a normalised position is a fifth of a pixel at 4K. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** True when two positions would produce the same `SetSegmentPosition`. */
export function samePosition(
  a: SegmentPosition | undefined,
  b: SegmentPosition | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y && a.anchor === b.anchor;
}

export interface SafeZones {
  /** The whole safe rectangle, in project pixels. */
  readonly safe: Box;
  /** The strip along the top platform chrome covers. */
  readonly top: Box;
  /** The strip along the bottom platform chrome covers. */
  readonly bottom: Box;
}

/** The guides the overlay draws; `safeAreaPct` is a percentage of the height. */
export function safeZonesFor(canvas: Size, safeAreaPct: number): SafeZones {
  const margin = (safeAreaPct / 100) * canvas.height;
  return {
    safe: [margin, margin, canvas.width - margin, canvas.height - margin],
    top: [0, 0, canvas.width, margin],
    bottom: [0, canvas.height - margin, canvas.width, canvas.height],
  };
}

/** True when a project-pixel point is inside a box; the hit test for a drag. */
export function boxContains(box: Box, point: Point): boolean {
  return point.x >= box[0] && point.x <= box[2] && point.y >= box[1] && point.y <= box[3];
}

/** A project-pixel box in CSS pixels, for positioning the drag handle. */
export function boxToCss(
  box: Box,
  fit: StageFit,
): { left: number; top: number; width: number; height: number } {
  return {
    left: fit.left + box[0] * fit.scale,
    top: fit.top + box[1] * fit.scale,
    width: (box[2] - box[0]) * fit.scale,
    height: (box[3] - box[1]) * fit.scale,
  };
}

/**
 * A normalised crop rectangle (`@montaj/render-core`'s `CropRect` — `x`/`y`/
 * `w`/`h` as fractions of the source frame, `frame/crop-window.ts`'s shape),
 * turned into a project-pixel `Box` (B20b: the canvas overlay showing the
 * current zoom/reframe crop window during scrub). Structural, not imported —
 * this module has no dependency on `@montaj/render-core` and the shape is a
 * closed, four-field one unlikely to drift without CONTRACTS noticing.
 */
export function cropRectToBox(
  cropRect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  canvas: Size,
): Box {
  const left = cropRect.x * canvas.width;
  const top = cropRect.y * canvas.height;
  return [left, top, left + cropRect.w * canvas.width, top + cropRect.h * canvas.height];
}
