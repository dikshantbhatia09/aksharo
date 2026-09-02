import { describe, expect, it } from "vitest";

import { decodeKeyframes, encodeKeyframes, type Keyframe } from "./keyframes";

describe("decodeKeyframes / encodeKeyframes (B19's real MKF2 format, re-exported)", () => {
  it("round-trips a keyframe curve", () => {
    const frames: Keyframe[] = [
      { tMs: 0, zoom: 1, cx: 0.5, cy: 0.5, ease: "linear" },
      { tMs: 500, zoom: 2, cx: 0.4, cy: 0.3, ease: "inOut" },
    ];
    const bytes = encodeKeyframes(frames);
    const decoded = decodeKeyframes(bytes);
    expect(decoded).toHaveLength(2);
    expect(decoded[1]?.zoom).toBeCloseTo(2, 4);
    expect(decoded[1]?.ease).toBe("inOut");
  });

  it("throws on a buffer with the wrong magic", () => {
    expect(() => decodeKeyframes(new Uint8Array(12))).toThrow();
  });
});
