import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  decodeKeyframes,
  encodeKeyframes,
  KeyframeDecodeError,
  type Keyframe,
} from "./keyframes.js";

const frame = (
  tMs: number,
  zoom: number,
  cx: number,
  cy: number,
  ease: Keyframe["ease"],
): Keyframe => ({
  tMs,
  zoom,
  cx,
  cy,
  ease,
});

describe("encodeKeyframes / decodeKeyframes", () => {
  it("round-trips an empty curve", () => {
    const packed = encodeKeyframes([]);
    expect(packed.byteLength).toBe(12);
    expect(decodeKeyframes(packed)).toEqual([]);
  });

  it("round-trips a typical zoom curve, in time order, with ease preserved", () => {
    const frames = [
      frame(0, 1, 0.5, 0.5, "linear"),
      frame(180, 1.2, 0.5, 0.5, "inOut"),
      frame(780, 1.2, 0.5, 0.5, "inOut"),
    ];
    const packed = encodeKeyframes(frames);
    expect(packed.byteLength).toBe(12 + frames.length * 20);
    const decoded = decodeKeyframes(packed);
    expect(decoded).toHaveLength(3);
    for (const [index, expected] of frames.entries()) {
      expect(decoded[index]?.tMs).toBeCloseTo(expected.tMs, 3);
      expect(decoded[index]?.zoom).toBeCloseTo(expected.zoom, 5);
      expect(decoded[index]?.cx).toBeCloseTo(expected.cx, 5);
      expect(decoded[index]?.cy).toBeCloseTo(expected.cy, 5);
      expect(decoded[index]?.ease).toBe(expected.ease);
    }
  });

  it("sorts rows by tMs before packing", () => {
    const packed = encodeKeyframes([
      frame(500, 1, 0.1, 0.1, "linear"),
      frame(0, 1, 0.2, 0.2, "inOut"),
    ]);
    const decoded = decodeKeyframes(packed);
    expect(decoded.map((f) => f.tMs)).toEqual([0, 500]);
    expect(decoded.map((f) => f.ease)).toEqual(["inOut", "linear"]);
  });

  it("round-trips via a property test across arbitrary curves", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            tMs: fc.integer({ min: 0, max: 2_000_000 }).map((n) => Math.fround(n)),
            zoom: fc.float({ min: 1, max: 4, noNaN: true }).map(Math.fround),
            cx: fc.float({ min: 0, max: 1, noNaN: true }).map(Math.fround),
            cy: fc.float({ min: 0, max: 1, noNaN: true }).map(Math.fround),
            ease: fc.constantFrom<Keyframe["ease"]>("linear", "inOut"),
          }),
          { minLength: 0, maxLength: 64 },
        ),
        (frames) => {
          const decoded = decodeKeyframes(encodeKeyframes(frames));
          const expected = [...frames].sort((a, b) => a.tMs - b.tMs);
          expect(decoded).toHaveLength(expected.length);
          decoded.forEach((got, index) => {
            expect(got.tMs).toBe(expected[index]?.tMs);
            expect(got.zoom).toBe(expected[index]?.zoom);
            expect(got.cx).toBe(expected[index]?.cx);
            expect(got.cy).toBe(expected[index]?.cy);
            expect(got.ease).toBe(expected[index]?.ease);
          });
        },
      ),
    );
  });

  it("rejects a buffer with bad magic", () => {
    expect(() => decodeKeyframes(new Uint8Array(12))).toThrow(KeyframeDecodeError);
  });

  it("rejects a buffer whose length disagrees with its count header", () => {
    const packed = encodeKeyframes([frame(0, 1, 0.5, 0.5, "linear")]);
    const truncated = packed.slice(0, packed.length - 1);
    expect(() => decodeKeyframes(truncated)).toThrow(KeyframeDecodeError);
  });

  it("rejects an unsupported version", () => {
    const packed = encodeKeyframes([frame(0, 1, 0.5, 0.5, "linear")]);
    const mutated = new Uint8Array(packed);
    new DataView(mutated.buffer).setUint32(4, 99, true);
    expect(() => decodeKeyframes(mutated)).toThrow(KeyframeDecodeError);
  });

  it("rejects a buffer shorter than the header", () => {
    expect(() => decodeKeyframes(new Uint8Array(4))).toThrow(KeyframeDecodeError);
  });
});
