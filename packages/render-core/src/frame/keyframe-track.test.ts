import { describe, expect, it } from "vitest";

import { decodeCropRows, outputCropKeyframesFromTracks } from "./keyframe-track.js";

/** Encodes rows the same way `apps/web/lib/passes/keyframes.ts`'s `encodeKeyframes` does, for round-trip tests. */
function encodeBase64(rows: { tMs: number; rect: { x: number; y: number; w: number; h: number } }[]): string {
  const bytes = new Uint8Array(rows.length * 5 * 4);
  const view = new DataView(bytes.buffer);
  rows.forEach((row, index) => {
    const offset = index * 5 * 4;
    view.setFloat32(offset, row.tMs, true);
    view.setFloat32(offset + 4, row.rect.x, true);
    view.setFloat32(offset + 8, row.rect.y, true);
    view.setFloat32(offset + 12, row.rect.w, true);
    view.setFloat32(offset + 16, row.rect.h, true);
  });
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return typeof Buffer !== "undefined" ? Buffer.from(bytes).toString("base64") : btoa(binary);
}

describe("decodeCropRows", () => {
  it("round-trips through the hand-rolled base64 decoder", () => {
    const packed = encodeBase64([
      { tMs: 0, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { tMs: 1500, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
    ]);
    const rows = decodeCropRows(packed);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.tMs).toBeCloseTo(1500, 2);
    expect(rows[1]?.rect.w).toBeCloseTo(0.3, 4);
  });

  it("throws on a truncated buffer", () => {
    expect(() => decodeCropRows("QQ==")).toThrow(RangeError);
  });
});

describe("outputCropKeyframesFromTracks", () => {
  it("returns [] with no tracks", () => {
    expect(outputCropKeyframesFromTracks([], null)).toEqual([]);
  });

  it("passes source-clock rows through unchanged with no timemap", () => {
    const packed = encodeBase64([{ tMs: 250, rect: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } }]);
    const result = outputCropKeyframesFromTracks([{ packed }], null);
    expect(result).toHaveLength(1);
    expect(result[0]?.tMs).toBeCloseTo(250, 2);
    expect(result[0]?.rect.x).toBeCloseTo(0.5, 5);
    expect(result[0]?.rect.w).toBeCloseTo(0.1, 5);
  });
});
