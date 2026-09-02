import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  fitsInline,
  INLINE_LIMIT_BYTES,
  KeyframeFormatError,
  loadKeyframes,
  packKeyframes,
  unpackKeyframes,
  type KeyframeRow,
} from "./keyframes.js";

const row = (tMs: number, cx: number, cy: number, scale: number): KeyframeRow => ({
  tMs,
  cx,
  cy,
  scale,
});

describe("packKeyframes / unpackKeyframes", () => {
  it("round-trips an empty curve", () => {
    const packed = packKeyframes([]);
    expect(packed.byteLength).toBe(12); // header only
    expect(unpackKeyframes(packed)).toEqual([]);
  });

  it("round-trips a typical zoom curve, in time order", () => {
    const rows = [row(0, 0.5, 0.5, 1), row(180, 0.5, 0.5, 1.2), row(780, 0.5, 0.5, 1.2)];
    const packed = packKeyframes(rows);
    expect(packed.byteLength).toBe(12 + rows.length * 16);
    const decoded = unpackKeyframes(packed);
    expect(decoded).toHaveLength(3);
    for (const [index, expected] of rows.entries()) {
      expect(decoded[index]?.tMs).toBeCloseTo(expected.tMs, 3);
      expect(decoded[index]?.cx).toBeCloseTo(expected.cx, 5);
      expect(decoded[index]?.cy).toBeCloseTo(expected.cy, 5);
      expect(decoded[index]?.scale).toBeCloseTo(expected.scale, 5);
    }
  });

  it("sorts rows by tMs before packing", () => {
    const packed = packKeyframes([row(500, 0.1, 0.1, 1), row(0, 0.2, 0.2, 1)]);
    const decoded = unpackKeyframes(packed);
    expect(decoded.map((r) => r.tMs)).toEqual([0, 500]);
  });

  it("round-trips via a property test across arbitrary curves", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            tMs: fc.integer({ min: 0, max: 2_000_000 }).map((n) => Math.fround(n)),
            cx: fc.float({ min: 0, max: 1, noNaN: true }).map(Math.fround),
            cy: fc.float({ min: 0, max: 1, noNaN: true }).map(Math.fround),
            scale: fc.float({ min: 1, max: 4, noNaN: true }).map(Math.fround),
          }),
          { minLength: 0, maxLength: 64 },
        ),
        (rows) => {
          const decoded = unpackKeyframes(packKeyframes(rows));
          const expected = [...rows].sort((a, b) => a.tMs - b.tMs);
          expect(decoded).toHaveLength(expected.length);
          decoded.forEach((got, index) => {
            expect(got.tMs).toBe(expected[index]?.tMs);
            expect(got.cx).toBe(expected[index]?.cx);
            expect(got.cy).toBe(expected[index]?.cy);
            expect(got.scale).toBe(expected[index]?.scale);
          });
        },
      ),
    );
  });

  it("rejects a buffer with bad magic", () => {
    const bad = new Uint8Array(12);
    expect(() => unpackKeyframes(bad)).toThrow(KeyframeFormatError);
  });

  it("rejects a buffer whose length disagrees with its count header", () => {
    const packed = packKeyframes([row(0, 0.5, 0.5, 1)]);
    const truncated = packed.slice(0, packed.length - 1);
    expect(() => unpackKeyframes(truncated)).toThrow(KeyframeFormatError);
  });

  it("rejects an unsupported version", () => {
    const packed = packKeyframes([row(0, 0.5, 0.5, 1)]);
    const mutated = new Uint8Array(packed);
    new DataView(mutated.buffer).setUint32(4, 99, true);
    expect(() => unpackKeyframes(mutated)).toThrow(KeyframeFormatError);
  });

  it("rejects a buffer shorter than the header", () => {
    expect(() => unpackKeyframes(new Uint8Array(4))).toThrow(KeyframeFormatError);
  });
});

describe("fitsInline", () => {
  it("is true at and under the 64 KiB limit, false just over it", () => {
    expect(fitsInline(new Uint8Array(INLINE_LIMIT_BYTES))).toBe(true);
    expect(fitsInline(new Uint8Array(INLINE_LIMIT_BYTES + 1))).toBe(false);
  });
});

describe("loadKeyframes", () => {
  it("resolves an inline source without calling readRef", async () => {
    const rows = [row(0, 0.5, 0.5, 1)];
    const packed = packKeyframes(rows);
    let called = false;
    const decoded = await loadKeyframes({ kind: "inline", bytes: packed }, async () => {
      called = true;
      return new Uint8Array();
    });
    expect(called).toBe(false);
    expect(decoded[0]?.tMs).toBe(0);
  });

  it("resolves a ref source through readRef", async () => {
    const rows = [row(0, 0.4, 0.6, 1.3)];
    const packed = packKeyframes(rows);
    const decoded = await loadKeyframes({ kind: "ref", ref: "passes/p1/i1.kf" }, async (ref) => {
      expect(ref).toBe("passes/p1/i1.kf");
      return packed;
    });
    expect(decoded[0]?.scale).toBeCloseTo(1.3, 5);
  });
});
