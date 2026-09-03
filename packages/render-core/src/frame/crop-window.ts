/**
 * The zoom/reframe crop window: one normalised source rectangle per output
 * millisecond, shared by the browser exporter (A19/B20) and the cloud
 * renderer (A20/B20) so both backends sample the same pixels from the same
 * source frame.
 *
 * A `zoom` pass item and a `reframe` pass item both boil down to the same
 * thing here — "which normalised `[0,1]` rectangle of the source frame is
 * shown, scaled to fill the output canvas" — so both are reduced to
 * {@link CropKeyframe} before reaching this module: a zoom's `target` +
 * `scale` becomes the rectangle centred on `target` at `1/scale` the frame
 * size (a bigger `scale` is a tighter, smaller rectangle); a reframe's crop
 * rectangle is already exactly this shape (CONTRACTS §2 `ReframePayload`).
 *
 * `sampleCropWindow` is a pure function of `(keyframes, outputMs)`: no clock,
 * no previous-frame state, so a scrub and an export land on the same pixel
 * for the same instant (the same property `render-frame.ts` documents for
 * captions).
 */

import { type Easing, linear, easeInOutCubic } from "../animate/easing.js";
import { clamp01 } from "../units.js";

/** Normalised `[0,1]` rectangle of the source frame. */
export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type CropEasingName = "linear" | "easeInOutCubic";

/** One point on the crop-window curve, already on the **output** clock. */
export interface CropKeyframe {
  readonly tMs: number;
  readonly rect: CropRect;
  /** Eases the segment starting at this keyframe; ignored on the last one. */
  readonly easing?: CropEasingName;
}

const EASINGS_BY_NAME: Record<CropEasingName, Easing> = {
  linear,
  easeInOutCubic,
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Linearly interpolates two crop rects; exported for callers merging tracks (e.g. B20's manifest adapters). */
export function lerpCropRect(a: CropRect, b: CropRect, t: number): CropRect {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    w: lerp(a.w, b.w, t),
    h: lerp(a.h, b.h, t),
  };
}

/** Clamps a crop rect to stay inside the `[0,1]` frame without changing its size. */
export function clampCropRect(rect: CropRect): CropRect {
  const w = Math.min(1, Math.max(0, rect.w));
  const h = Math.min(1, Math.max(0, rect.h));
  const x = Math.min(1 - w, Math.max(0, rect.x));
  const y = Math.min(1 - h, Math.max(0, rect.y));
  return { x, y, w, h };
}

/**
 * The identity window: the whole frame, for the common case (no zoom/reframe
 * item touches this output instant).
 */
export const FULL_FRAME: CropRect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * Samples the crop window at `outputMs`.
 *
 * `keyframes` must be sorted by `tMs` (both `apps/web/lib/passes/keyframes.ts`
 * and the cloud pipeline produce them that way — `@montaj/timemap`'s
 * `mapKeyframes` guarantees output order). Before the first keyframe and after
 * the last, the window holds at the nearest one; `null` (not `FULL_FRAME`)
 * when there are no keyframes at all, so a caller can tell "no zoom/reframe
 * item is active" from "an item shrank the window to nothing".
 */
export function sampleCropWindow(
  keyframes: readonly CropKeyframe[],
  outputMs: number,
): CropRect | null {
  if (keyframes.length === 0) return null;
  if (keyframes.length === 1) return clampCropRect((keyframes[0] as CropKeyframe).rect);

  if (outputMs <= (keyframes[0] as CropKeyframe).tMs) {
    return clampCropRect((keyframes[0] as CropKeyframe).rect);
  }
  const last = keyframes[keyframes.length - 1] as CropKeyframe;
  if (outputMs >= last.tMs) return clampCropRect(last.rect);

  // Binary search for the segment `[lo, lo+1]` containing `outputMs`.
  let lo = 0;
  let hi = keyframes.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    if ((keyframes[mid] as CropKeyframe).tMs <= outputMs) lo = mid;
    else hi = mid - 1;
  }
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const before = keyframes[lo] as CropKeyframe;
  const after = keyframes[lo + 1] as CropKeyframe;
  const span = after.tMs - before.tMs;
  const ratio = span > 0 ? clamp01((outputMs - before.tMs) / span) : 0;
  const eased = EASINGS_BY_NAME[before.easing ?? "linear"](ratio);
  return clampCropRect(lerpCropRect(before.rect, after.rect, eased));
}

/** Builds a zoom item's crop rectangle: centred on `target`, sized `1/scale`. */
export function cropRectFromZoom(target: CropRect, scale: number): CropRect {
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  return cropRectFromCentre(cx, cy, scale);
}

/**
 * Builds a crop rectangle centred on `(cx, cy)` at `zoom` (>= 1, `1` meaning
 * "no zoom"), the shape B19's `@montaj/edg` `passes/keyframes.ts` `Keyframe`
 * carries for both `zoom` and `reframe` items alike (B20 consumes it via
 * `keyframe-track.ts`).
 */
export function cropRectFromCentre(cx: number, cy: number, zoom: number): CropRect {
  const size = 1 / Math.max(zoom, 1e-6);
  return clampCropRect({ x: cx - size / 2, y: cy - size / 2, w: size, h: size });
}
