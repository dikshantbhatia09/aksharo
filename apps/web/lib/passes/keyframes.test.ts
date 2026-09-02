import { describe, expect, it } from "vitest";

import {
  decodeKeyframes,
  encodeKeyframes,
  packKeyframesBase64,
  unpackKeyframesBase64,
} from "./keyframes";

describe("decodeKeyframes", () => {
  it("decodes reframe rows: [tMs, x, y, w, h] float32 little-endian", () => {
    const bytes = encodeKeyframes(
      [
        { tMs: 0, rect: { x: 0, y: 0, w: 1, h: 1 } },
        { tMs: 1000, rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } },
      ],
      "reframe",
    );
    const rows = decodeKeyframes(bytes, "reframe");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.tMs).toBeCloseTo(0, 4);
    expect(rows[1]?.rect.x).toBeCloseTo(0.25, 4);
    expect(rows[1]?.rect.w).toBeCloseTo(0.5, 4);
  });

  it("decodes zoom rows and reduces target+scale to a crop rect", () => {
    // [tMs, targetX, targetY, targetW, targetH, scale]
    const buf = new ArrayBuffer(6 * 4);
    const view = new DataView(buf);
    view.setFloat32(0, 0, true);
    view.setFloat32(4, 0.4, true); // targetX
    view.setFloat32(8, 0.4, true); // targetY
    view.setFloat32(12, 0.2, true); // targetW
    view.setFloat32(16, 0.2, true); // targetH
    view.setFloat32(20, 2, true); // scale
    const rows = decodeKeyframes(buf, "zoom");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rect.w).toBeCloseTo(0.5, 4);
    expect(rows[0]?.rect.x + (rows[0]?.rect.w ?? 0) / 2).toBeCloseTo(0.5, 4);
  });

  it("throws on a buffer that is not a whole multiple of the row size", () => {
    expect(() => decodeKeyframes(new ArrayBuffer(7), "reframe")).toThrow(RangeError);
  });

  it("sorts rows by tMs defensively", () => {
    const bytes = encodeKeyframes(
      [
        { tMs: 1000, rect: { x: 0, y: 0, w: 1, h: 1 } },
        { tMs: 0, rect: { x: 0.1, y: 0.1, w: 0.9, h: 0.9 } },
      ],
      "reframe",
    );
    const rows = decodeKeyframes(bytes, "reframe");
    expect(rows.map((r) => r.tMs)).toEqual([0, 1000]);
  });

  it("round-trips through base64 for the manifest wire form", () => {
    const rows = [
      { tMs: 0, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { tMs: 2500, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
    ];
    const packed = packKeyframesBase64(rows);
    expect(typeof packed).toBe("string");
    const roundTripped = unpackKeyframesBase64(packed);
    expect(roundTripped).toHaveLength(2);
    expect(roundTripped[1]?.rect.h).toBeCloseTo(0.4, 4);
  });
});
