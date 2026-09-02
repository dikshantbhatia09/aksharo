/**
 * Packed keyframe decode/encode — the seam B19 (reframe/zoom pass) satisfies.
 *
 * B19 (`packages/edg`'s `ZoomPayload`/`ReframePayload.keyframesRef`, D28) packs
 * a pass item's curve as rows of little-endian float32s in a Postgres `bytea`
 * and hands back a reference string; the actual bytes are fetched from
 * wherever B19 stores them (not yet on `main` when this file was written — see
 * `05-build/_orchestration/B20-proposal-review-and-apply.md`). This module is
 * the documented interface B20 builds against in the meantime:
 *
 *   `decodeKeyframes(bytea, kind) → Keyframe[]`
 *
 * so every consumer (the Passes tab's canvas overlay, the export manifest
 * builder, the timeline lanes) reads one shape. When B19 lands, only the
 * function that *fetches* the bytes (not written here — that is an API call)
 * needs to appear; this decoder's row layout must match B19's packer, so if
 * B19's actual layout differs from the one documented below, that is the one
 * conflict to raise rather than silently reconcile.
 *
 * ## Row layout (this seam's contract)
 *
 * - `reframe`: 5 float32s per row, `[tMs, x, y, w, h]` — a normalised `[0,1]`
 *   source rectangle, straight from `ReframePayload.keyframesRef` (CONTRACTS
 *   §2 comment: "Packed float32 `[tMs, x, y, w, h]` rows").
 * - `zoom`: 6 float32s per row, `[tMs, targetX, targetY, targetW, targetH,
 *   scale]` — the zoom's `target` rect (fixed for the item in the common case,
 *   but carried per-row so a "drifting" zoom is representable) and the scale
 *   at that instant; reduced to the same crop-rectangle shape as a reframe via
 *   `@montaj/render-core`'s `cropRectFromZoom` before it reaches
 *   `sampleCropWindow`.
 *
 * All multi-byte values are little-endian, matching `DataView`'s default for
 * `getFloat32(offset, true)` and every platform this repo targets.
 */

import { cropRectFromZoom, type CropRect } from "@montaj/render-core";

export type PackedItemKind = "zoom" | "reframe";

/** One row of a packed keyframe curve, on whichever clock the caller fetched it. */
export interface Keyframe {
  readonly tMs: number;
  readonly rect: CropRect;
}

const BYTES_PER_FLOAT = 4;
const REFRAME_FIELDS = 5; // tMs, x, y, w, h
const ZOOM_FIELDS = 6; // tMs, targetX, targetY, targetW, targetH, scale

function fieldsFor(kind: PackedItemKind): number {
  return kind === "reframe" ? REFRAME_FIELDS : ZOOM_FIELDS;
}

/**
 * Decodes a packed keyframe `bytea` into ordered {@link Keyframe} rows.
 *
 * Throws rather than truncating silently when the buffer length is not a
 * whole multiple of the row size — a partial row means either a corrupt
 * fetch or a row-layout mismatch with the packer, and either is a bug to
 * surface, not a frame to draw wrong.
 */
export function decodeKeyframes(bytea: ArrayBuffer | Uint8Array, kind: PackedItemKind): Keyframe[] {
  const bytes = bytea instanceof Uint8Array ? bytea : new Uint8Array(bytea);
  const fields = fieldsFor(kind);
  const rowBytes = fields * BYTES_PER_FLOAT;
  if (bytes.byteLength % rowBytes !== 0) {
    throw new RangeError(
      `packed ${kind} keyframes: ${String(bytes.byteLength)} bytes is not a whole multiple of ` +
        `${String(rowBytes)} (${String(fields)} float32 fields per row)`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: Keyframe[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += rowBytes) {
    const tMs = view.getFloat32(offset, true);
    if (kind === "reframe") {
      const x = view.getFloat32(offset + 4, true);
      const y = view.getFloat32(offset + 8, true);
      const w = view.getFloat32(offset + 12, true);
      const h = view.getFloat32(offset + 16, true);
      rows.push({ tMs, rect: { x, y, w, h } });
    } else {
      const targetX = view.getFloat32(offset + 4, true);
      const targetY = view.getFloat32(offset + 8, true);
      const targetW = view.getFloat32(offset + 12, true);
      const targetH = view.getFloat32(offset + 16, true);
      const scale = view.getFloat32(offset + 20, true);
      rows.push({
        tMs,
        rect: cropRectFromZoom({ x: targetX, y: targetY, w: targetW, h: targetH }, scale),
      });
    }
  }
  // Guaranteed ordered: every packer in this repo writes rows in `tMs` order,
  // but a defensive sort costs nothing next to a decode and protects every
  // downstream binary search (`sampleCropWindow`, `mapKeyframes`).
  rows.sort((a, b) => a.tMs - b.tMs);
  return rows;
}

/** The inverse of `decodeKeyframes`, for round-trip tests and manifest packing. */
export function encodeKeyframes(
  rows: readonly { tMs: number; rect: CropRect }[],
  kind: Extract<PackedItemKind, "reframe">,
): Uint8Array {
  const fields = fieldsFor(kind);
  const bytes = new Uint8Array(rows.length * fields * BYTES_PER_FLOAT);
  const view = new DataView(bytes.buffer);
  rows.forEach((row, index) => {
    const offset = index * fields * BYTES_PER_FLOAT;
    view.setFloat32(offset, row.tMs, true);
    view.setFloat32(offset + 4, row.rect.x, true);
    view.setFloat32(offset + 8, row.rect.y, true);
    view.setFloat32(offset + 12, row.rect.w, true);
    view.setFloat32(offset + 16, row.rect.h, true);
  });
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
   
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
   
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Already-normalised rows (already reduced to a crop rect), packed as `reframe` rows for the wire. */
export function packKeyframesBase64(rows: readonly Keyframe[]): string {
  return toBase64(encodeKeyframes(rows, "reframe"));
}

/** The manifest's wire form, decoded back to rows already reduced to a crop rect. */
export function unpackKeyframesBase64(packed: string): Keyframe[] {
  return decodeKeyframes(fromBase64(packed), "reframe");
}
