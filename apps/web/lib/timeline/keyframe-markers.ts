/**
 * Timeline keyframe markers + the zoom lane's mini scale-curve plot (B20b),
 * built from a pass item's decoded keyframe curve
 * (`@montaj/edg`'s `decodeKeyframes`, `lib/passes/keyframes.ts`'s
 * re-export). Pure geometry — no canvas, no React — so `Timeline.tsx` (a
 * `"use client"` Canvas2D component, `stage-geometry.ts`'s precedent) can
 * draw the result without this module knowing pixels-per-ms or lane height.
 */
import { decodeKeyframes, type Keyframe } from "@montaj/edg";

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decodes a zoom/reframe item's *inline* keyframe curve
 * (`payload.keyframes`, base64 MKF2), or `undefined` when the item carries
 * none (a `keyframesRef` item, or a non-keyframe kind) — the lane draw
 * skips markers for that item rather than fetching bytes from a pure
 * function, the same rule `../current-crop-rect.ts` follows.
 */
export function decodeItemKeyframes(
  payload: Record<string, unknown>,
): readonly Keyframe[] | undefined {
  const inline = typeof payload["keyframes"] === "string" ? payload["keyframes"] : undefined;
  if (inline === undefined) return undefined;
  try {
    return decodeKeyframes(base64ToBytes(inline));
  } catch {
    return undefined;
  }
}

/** One marker on the timeline, in absolute source-clock ms (item.startMs + keyframe.tMs). */
export interface KeyframeMarker {
  readonly tMs: number;
  readonly zoom: number;
}

/** Absolute-clock markers for one item's decoded keyframes, sorted by time. */
export function keyframeMarkersOf(
  keyframes: readonly Keyframe[],
  itemStartMs: number,
): readonly KeyframeMarker[] {
  return [...keyframes]
    .map((frame) => ({ tMs: itemStartMs + frame.tMs, zoom: frame.zoom }))
    .sort((a, b) => a.tMs - b.tMs);
}

export interface PlotPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The zoom lane's mini scale-curve plot (brief §4: "zoom lane with keyframe
 * markers and scale curve mini-plot"): one `{x, y}` per marker, `x` linear in
 * `[0, widthPx]` across `[startMs, endMs]` and `y` linear in `[0, heightPx]`
 * across the curve's own `[minZoom, maxZoom]` (inverted — `y = 0` is the
 * plot's top, matching every other canvas draw in this codebase), so the
 * caller can join the points with `lineTo` and get a legible sparkline
 * regardless of the item's own zoom range. A single-keyframe curve (no
 * ramp) draws a flat line at mid-height — nothing to compare it against, so
 * neither "high" nor "low" would mean anything.
 */
export function zoomMiniPlotPoints(
  markers: readonly KeyframeMarker[],
  bounds: { readonly startMs: number; readonly endMs: number },
  size: { readonly widthPx: number; readonly heightPx: number },
): readonly PlotPoint[] {
  if (markers.length === 0) return [];
  const durationMs = Math.max(1, bounds.endMs - bounds.startMs);
  const zooms = markers.map((m) => m.zoom);
  const minZoom = Math.min(...zooms);
  const maxZoom = Math.max(...zooms);
  const zoomRange = maxZoom - minZoom;

  return markers.map((marker) => {
    const x = ((marker.tMs - bounds.startMs) / durationMs) * size.widthPx;
    const y =
      zoomRange <= 0
        ? size.heightPx / 2
        : size.heightPx - ((marker.zoom - minZoom) / zoomRange) * size.heightPx;
    return { x, y };
  });
}
