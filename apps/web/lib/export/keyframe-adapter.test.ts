import { describe, expect, it } from "vitest";

import { encodeKeyframes, type Keyframe } from "@montaj/edg";
import { signedFixtureManifest } from "@montaj/render-manifest/testing";

import { outputCropKeyframesFromManifest } from "./keyframe-adapter";
import { timeMapFromManifest } from "./timemap-adapter";

const SECRET = "test-secret";

function packBase64(frames: Keyframe[]): string {
  const bytes = encodeKeyframes(frames);
  return typeof Buffer !== "undefined"
    ? Buffer.from(bytes).toString("base64")
    : btoa(String.fromCharCode(...bytes));
}

describe("outputCropKeyframesFromManifest", () => {
  it("returns nothing when the manifest carries no keyframe tracks", () => {
    const manifest = signedFixtureManifest(SECRET, {
      timemap: { sourceDurationMs: 10_000, edits: [], snapCutsToFrames: false },
    });
    expect(outputCropKeyframesFromManifest(manifest, null)).toEqual([]);
  });

  it("decodes B19's MKF2 rows, offsets by itemStartMs, unchanged with no edits", () => {
    const packed = packBase64([
      { tMs: 0, zoom: 1, cx: 0.5, cy: 0.5, ease: "linear" },
      { tMs: 1_000, zoom: 2, cx: 0.4, cy: 0.4, ease: "linear" },
    ]);
    const manifest = signedFixtureManifest(SECRET, {
      timemap: {
        sourceDurationMs: 10_000,
        edits: [],
        snapCutsToFrames: false,
        keyframes: [
          { itemId: "01ARZ3NDEKTSV4RRFFQ69G5FA2", kind: "reframe", itemStartMs: 500, packed },
        ],
      },
    });
    const result = outputCropKeyframesFromManifest(manifest, null);
    expect(result).toHaveLength(2);
    expect(result[0]?.tMs).toBe(500);
    expect(result[1]?.tMs).toBe(1_500);
    expect(result[1]?.rect.w).toBeCloseTo(0.5, 4);
  });

  it("shifts keyframes after a cut onto the output clock", () => {
    const packed = packBase64([
      { tMs: 0, zoom: 1, cx: 0.5, cy: 0.5, ease: "linear" },
      { tMs: 6_000, zoom: 1, cx: 0.5, cy: 0.5, ease: "linear" },
    ]);
    const manifest = signedFixtureManifest(SECRET, {
      timemap: {
        sourceDurationMs: 10_000,
        edits: [{ kind: "cut", startMs: 2_000, endMs: 5_000 }],
        snapCutsToFrames: false,
        keyframes: [
          { itemId: "01ARZ3NDEKTSV4RRFFQ69G5FA2", kind: "reframe", itemStartMs: 0, packed },
        ],
      },
    });
    const timeMap = timeMapFromManifest(manifest);
    const result = outputCropKeyframesFromManifest(manifest, timeMap);
    // Source 6000ms, after a [2000,5000) cut (3000ms removed), lands at output 3000ms.
    const last = result[result.length - 1];
    expect(last?.tMs).toBe(3_000);
  });
});
