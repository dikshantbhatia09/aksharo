import { describe, expect, it } from "vitest";

import { encodeKeyframes, type Keyframe as EdgKeyframe } from "@montaj/edg";

import { decodeCropRows, outputCropKeyframesFromTracks } from "./keyframe-track.js";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return typeof Buffer !== "undefined" ? Buffer.from(bytes).toString("base64") : btoa(binary);
}

describe("decodeCropRows", () => {
  it("decodes B19's MKF2 rows and adds the item's startMs back to tMs", () => {
    const frames: EdgKeyframe[] = [
      { tMs: 0, zoom: 1, cx: 0.5, cy: 0.5, ease: "linear" },
      { tMs: 1000, zoom: 2, cx: 0.4, cy: 0.4, ease: "inOut" },
    ];
    const packed = toBase64(encodeKeyframes(frames));
    const rows = decodeCropRows(packed, 5_000); // item starts at 5000ms
    expect(rows).toHaveLength(2);
    expect(rows[0]?.tMs).toBe(5_000);
    expect(rows[1]?.tMs).toBe(6_000);
    expect(rows[1]?.easing).toBe("easeInOutCubic");
    // zoom=2, centred at (0.4, 0.4) -> a 0.5x0.5 window centred there.
    expect(rows[1]?.rect.w).toBeCloseTo(0.5, 4);
    expect(rows[1]?.rect.x).toBeCloseTo(0.15, 4);
  });
});

describe("outputCropKeyframesFromTracks", () => {
  it("returns [] with no tracks", () => {
    expect(outputCropKeyframesFromTracks([], null)).toEqual([]);
  });

  it("passes rows through unchanged with no timemap, offset by itemStartMs", () => {
    const packed = toBase64(
      encodeKeyframes([{ tMs: 250, zoom: 1.5, cx: 0.5, cy: 0.5, ease: "linear" }]),
    );
    const result = outputCropKeyframesFromTracks([{ packed, itemStartMs: 1_000 }], null);
    expect(result).toHaveLength(1);
    expect(result[0]?.tMs).toBe(1_250);
  });
});
