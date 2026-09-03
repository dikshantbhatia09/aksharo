/**
 * Manifest keyframe tracks → the output-clock crop-window curve
 * {@link sampleCropWindow} samples — shared by the browser exporter and the
 * cloud renderer (B20), because both read the same manifest field
 * (`@montaj/render-manifest`'s `timemap.keyframes`, an array of `{itemId,
 * itemStartMs, kind, packed}`) and both need the same answer.
 *
 * `packed` is base64 of B19's real packed-keyframe wire format — `@montaj/edg`
 * `passes/keyframes.ts`'s `decodeKeyframes`, format `"MKF2"`: a `{tMs, zoom,
 * cx, cy, ease}` row per keyframe, `tMs` relative to the pass item's own
 * `startMs` (hence `itemStartMs` on the track — added to get back onto the
 * document's absolute source clock, which is what `@montaj/timemap` needs).
 * `zoom`+`cx`+`cy` is reduced to the same normalised crop rectangle a
 * `reframe` item's payload already is via `cropRectFromCentre` — B19 uses
 * this one row shape for both item kinds, so this module does not branch on
 * `kind` at all; it is carried on the track only for a caller that wants to
 * label which item produced a given segment of the curve.
 *
 * B20 was written against a self-documented, invented interim shape (`apps/
 * web/lib/passes/keyframes.ts`'s original `decodeKeyframes(bytea, kind)` —
 * `[tMs, x, y, w, h]` float32 rows, absolute `tMs`) before B19 landed; this
 * module is the real one, and that file now just re-exports B19's types for
 * anything still importing the old name. See the B20 final report for the
 * full account of what differed.
 */
import { decodeKeyframes as decodeEdgKeyframes, type Ease } from "@montaj/edg";
import type { TimeMap } from "@montaj/timemap";

import {
  cropRectFromCentre,
  lerpCropRect,
  type CropEasingName,
  type CropKeyframe,
} from "./crop-window.js";

const EASE_TO_CROP_EASING: Record<Ease, CropEasingName> = {
  linear: "linear",
  inOut: "easeInOutCubic",
};

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_INDEX: Record<string, number> = Object.fromEntries(
  [...BASE64_ALPHABET].map((ch, index) => [ch, index]),
);

/**
 * Hand-rolled, not `Buffer`/`atob`: this package runs in the browser and the
 * cloud renderer alike (`index.ts`'s "nothing DOM- or Node-only" rule).
 */
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const byteLength = Math.floor((clean.length * 6) / 8);
  const bytes = new Uint8Array(byteLength);
  let bitBuffer = 0;
  let bitCount = 0;
  let byteIndex = 0;
  for (const ch of clean) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const value = BASE64_INDEX[ch];
    if (value === undefined) continue;
    bitBuffer = (bitBuffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      bytes[byteIndex] = (bitBuffer >> bitCount) & 0xff;
      byteIndex += 1;
    }
  }
  return bytes;
}

/** Decodes one manifest keyframe track's `packed` base64 into ordered, absolute-source-clock rows. */
export function decodeCropRows(packed: string, itemStartMs: number): CropKeyframe[] {
  const bytes = base64ToBytes(packed);
  const rows = decodeEdgKeyframes(bytes);
  return rows
    .map((row) => ({
      tMs: itemStartMs + row.tMs,
      rect: cropRectFromCentre(row.cx, row.cy, row.zoom),
      easing: EASE_TO_CROP_EASING[row.ease],
    }))
    .sort((a, b) => a.tMs - b.tMs);
}

/** The manifest field shape this module reads — structurally, not by import, to avoid a package cycle. */
export interface PackedKeyframeTrack {
  readonly packed: string;
  /** The pass item's `startMs` — B19's row `tMs` is relative to it. */
  readonly itemStartMs: number;
}

/**
 * Decodes every track, remaps each onto the output clock (pinning at every
 * splice it crosses, via `timeMap.mapKeyframes`) and concatenates them in
 * time order. `timeMap === null` (no edits at all) passes the source-clock
 * rows through unchanged, matching every other "no edits" shortcut in this
 * codebase (`timeMapFromManifest` callers, `renderFrame`'s own `timemap:
 * null`).
 */
export function outputCropKeyframesFromTracks(
  tracks: readonly PackedKeyframeTrack[],
  timeMap: TimeMap | null,
): CropKeyframe[] {
  if (tracks.length === 0) return [];
  const all: CropKeyframe[] = [];
  for (const track of tracks) {
    const sourceRows = decodeCropRows(track.packed, track.itemStartMs);
    const remapped =
      timeMap === null
        ? sourceRows
        : timeMap.mapKeyframes(sourceRows, {
            interpolate: (before, after, ratio) => ({
              tMs: 0, // overwritten by mapKeyframes
              rect: lerpCropRect(before.rect, after.rect, ratio),
              ...(before.easing === undefined ? {} : { easing: before.easing }),
            }),
          });
    all.push(...remapped);
  }
  all.sort((a, b) => a.tMs - b.tMs);
  return all;
}
