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
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
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
  /** Safe-area margin as a percentage of the canvas's **short side**. */
  readonly safeAreaPct?: number;
  /** Whether to enable magnetic safe-zone snap (default: true for vertical canvases). */
  readonly enableSafeZoneSnap?: boolean;
}

export interface DragPositionResult extends SegmentPosition {
  readonly snappedToSafeZone?: boolean;
  readonly snapMessage?: string;
}

/**
 * The position a drag of `(dx, dy)` project pixels produces.
 *
 * The box is clamped, not the anchor point: dragging a wide caption to the edge
 * should stop when its *edge* reaches the safe area, which is what a creator
 * expects and what the renderer will do anyway.
 *
 * Implements Magnetic Safe-Zone Snap (Pillar 3 §08 Step 3):
 * If dragged below Y = 1440 px on a vertical canvas, snaps vertical position
 * back into the universal safe zone (baseline Y = 1380 px) with a warning tooltip.
 */
export function positionFromDrag(delta: Point, options: DragOptions): DragPositionResult {
  const { box, canvas, anchor, enableSafeZoneSnap = false } = options;
  const isVertical = canvas.height > canvas.width;
  // Percent of the SHORT side, both axes: height-based margins on a 9:16 canvas
  // made the horizontal clamp nearly 2× the intended zone (1920-derived margin on
  // a 1080-wide frame) — the audit's "far too aggressive horizontally".
  const margin = ((options.safeAreaPct ?? 0) / 100) * Math.min(canvas.width, canvas.height);
  const width = box[2] - box[0];
  const height = box[3] - box[1];

  const minLeft = margin;
  const maxLeft = Math.max(minLeft, canvas.width - margin - width);
  const minTop = margin;
  const maxTop = Math.max(minTop, canvas.height - margin - height);

  const rawLeft = Number.isNaN(delta.x) ? box[0] : box[0] + delta.x;
  const rawTop = Number.isNaN(delta.y) ? box[1] : box[1] + delta.y;

  let left = clamp(rawLeft, minLeft, maxLeft);
  let top = clamp(rawTop, minTop, maxTop);
  let snappedToSafeZone = false;
  let snapMessage: string | undefined;

  // Step 3 (08 §5): Magnetic Safe-Zone Snap on vertical 9:16 canvases
  // Snap vertical position back into safe zone if dragged below Y = 1440px
  if (isVertical && enableSafeZoneSnap) {
    const heightScale = canvas.height / 1920;
    const snapThresholdY = 1440 * heightScale;
    const safeBaselineY = 1380 * heightScale;
    const proposedBottom = top + height;

    if (proposedBottom > snapThresholdY) {
      snappedToSafeZone = true;
      snapMessage = "Snapped to TikTok safe zone";
      // Snap the box so its bottom aligns with the safe caption baseline
      top = Math.max(minTop, safeBaselineY - height);
    }
  }

  const moved: Box = [left, top, left + width, top + height];
  const point = anchorPointOf(moved, anchor);

  return {
    x: round(clamp(point.x / canvas.width, 0, 1)),
    y: round(clamp(point.y / canvas.height, 0, 1)),
    anchor,
    ...(snappedToSafeZone ? { snappedToSafeZone: true, snapMessage } : {}),
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

/** The guides the overlay draws; `safeAreaPct` is a percentage of the short side. */
export function safeZonesFor(canvas: Size, safeAreaPct: number): SafeZones {
  const margin = (safeAreaPct / 100) * Math.min(canvas.width, canvas.height);
  return {
    safe: [margin, margin, canvas.width - margin, canvas.height - margin],
    top: [0, 0, canvas.width, margin],
    bottom: [0, canvas.height - margin, canvas.width, canvas.height],
  };
}

/** Pixel-precise safe zones and exclusion zones for specific social media platforms (08 §4.1). */
export function platformSafeZonesFor(
  canvas: Size,
  platform: "tiktok" | "reels" | "shorts" | "universal" = "universal",
): SafeZones {
  const widthRatio = canvas.width / 1080;
  const heightRatio = canvas.height / 1920;
  const top = Math.round(160 * heightRatio);
  const bottomMargin = Math.round(
    (platform === "shorts" ? 340 : platform === "reels" ? 380 : 440) * heightRatio,
  );
  const rightMargin = Math.round(
    (platform === "reels" ? 110 : platform === "shorts" ? 120 : 130) * widthRatio,
  );
  const leftMargin = Math.round(50 * widthRatio);

  return {
    safe: [leftMargin, top, canvas.width - rightMargin, canvas.height - bottomMargin],
    top: [0, 0, canvas.width, top],
    bottom: [0, canvas.height - bottomMargin, canvas.width, canvas.height],
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
