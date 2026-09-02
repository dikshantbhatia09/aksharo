/**
 * Manifest keyframe tracks → the output-clock crop-window curve
 * {@link sampleCropWindow} samples — shared by the browser exporter and the
 * cloud renderer (B20), because both read the same manifest field
 * (`@montaj/render-manifest`'s `timemap.keyframes`, an array of
 * `{itemId, kind, packed}`) and both need the same answer.
 *
 * `packed` is base64 of five little-endian float32s per row —
 * `[tMs, x, y, w, h]`, a normalised `[0,1]` source rectangle (`apps/web/lib/
 * passes/keyframes.ts` documents the row layout in full; this module decodes
 * the same shape without depending on that app-level package, since this one
 * runs in the cloud renderer too). The base64 decoder here is hand-rolled
 * rather than `Buffer`/`atob` so this stays true to this package's "nothing
 * DOM- or Node-only" rule (`index.ts`) — the cloud renderer and the browser
 * both import this module directly.
 */
import type { TimeMap } from "@montaj/timemap";

import { lerpCropRect, type CropKeyframe, type CropRect } from "./crop-window.js";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_INDEX: Record<string, number> = Object.fromEntries(
  [...BASE64_ALPHABET].map((ch, index) => [ch, index]),
);

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const byteLength = Math.floor((clean.length * 6) / 8);
  const bytes = new Uint8Array(byteLength);
  let bitBuffer = 0;
  let bitCount = 0;
  let byteIndex = 0;
  for (const ch of clean) {
    const value = BASE64_INDEX[ch];
    if (value === undefined) continue;
    bitBuffer = (bitBuffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[byteIndex] = (bitBuffer >> bitCount) & 0xff;
      byteIndex += 1;
    }
  }
  return bytes;
}

const REFRAME_ROW_FIELDS = 5; // tMs, x, y, w, h
const REFRAME_ROW_BYTES = REFRAME_ROW_FIELDS * 4;

/** Decodes one manifest keyframe track's `packed` base64 into ordered rows. */
export function decodeCropRows(packed: string): { tMs: number; rect: CropRect }[] {
  const bytes = base64ToBytes(packed);
  if (bytes.byteLength % REFRAME_ROW_BYTES !== 0) {
    throw new RangeError(
      `packed crop keyframes: ${String(bytes.byteLength)} bytes is not a whole multiple of ` +
        `${String(REFRAME_ROW_BYTES)} (5 float32 fields per row)`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: { tMs: number; rect: CropRect }[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += REFRAME_ROW_BYTES) {
    rows.push({
      tMs: view.getFloat32(offset, true),
      rect: {
        x: view.getFloat32(offset + 4, true),
        y: view.getFloat32(offset + 8, true),
        w: view.getFloat32(offset + 12, true),
        h: view.getFloat32(offset + 16, true),
      },
    });
  }
  rows.sort((a, b) => a.tMs - b.tMs);
  return rows;
}

/** The manifest field shape this module reads — structurally, not by import, to avoid a package cycle. */
export interface PackedKeyframeTrack {
  readonly packed: string;
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
    const rows = decodeCropRows(track.packed);
    const asCropKeyframes: CropKeyframe[] = rows.map((row) => ({ tMs: row.tMs, rect: row.rect }));
    const remapped =
      timeMap === null
        ? asCropKeyframes
        : timeMap.mapKeyframes(asCropKeyframes, {
            interpolate: (before, after, ratio) => ({
              tMs: 0, // overwritten by mapKeyframes
              rect: lerpCropRect(before.rect, after.rect, ratio),
            }),
          });
    all.push(...remapped);
  }
  all.sort((a, b) => a.tMs - b.tMs);
  return all;
}
