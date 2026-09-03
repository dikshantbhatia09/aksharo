/**
 * The crop window an accepted zoom/reframe item wants at a given instant
 * (B20b's canvas overlay + scrub preview) — decodes the item's *inline*
 * keyframe curve (`payload.keyframes`, base64 MKF2) and samples it exactly
 * the way `@montaj/render-core`'s `sampleCropWindow` does for both render
 * paths.
 *
 * A `keyframesRef` item (too large to inline, B19b's derived-storage path)
 * has no bytes to decode here without a fetch this pure function cannot
 * make — it is skipped, matching the brief's explicit fallback for a scrub
 * preview with nothing to draw: no crop rectangle for that item, rather than
 * a stale or wrong one.
 */
import { decodeKeyframes, type PassItem } from "@montaj/edg";
import {
  cropRectFromCentre,
  sampleCropWindow,
  type CropKeyframe,
  type CropRect,
} from "@montaj/render-core";

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** The accepted zoom/reframe item (if any) whose range covers `atMs`. */
export function activeCropItem(items: readonly PassItem[], atMs: number): PassItem | undefined {
  return items.find(
    (item) =>
      item.state === "accepted" &&
      (item.kind === "zoom" || item.kind === "reframe") &&
      atMs >= item.startMs &&
      atMs <= item.endMs,
  );
}

/**
 * The crop rectangle at `atMs`, or `null` when no accepted zoom/reframe item
 * covers it, or its curve is a `keyframesRef` this function cannot fetch.
 */
export function currentCropRect(items: readonly PassItem[], atMs: number): CropRect | null {
  const item = activeCropItem(items, atMs);
  if (item === undefined) return null;

  const payload = item.payload as Record<string, unknown>;
  const inline = typeof payload["keyframes"] === "string" ? payload["keyframes"] : undefined;
  if (inline === undefined) return null;

  const frames = decodeKeyframes(base64ToBytes(inline));
  if (frames.length === 0) return null;

  const cropFrames: CropKeyframe[] = frames.map((frame) => ({
    tMs: frame.tMs,
    rect: cropRectFromCentre(frame.cx, frame.cy, frame.zoom),
    easing: frame.ease === "inOut" ? "easeInOutCubic" : "linear",
  }));
  return sampleCropWindow(cropFrames, atMs - item.startMs);
}
