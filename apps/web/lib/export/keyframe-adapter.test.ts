import { signedFixtureManifest } from "@montaj/render-manifest/testing";
import { describe, expect, it } from "vitest";

import { packKeyframesBase64 } from "../passes/keyframes";
import { outputCropKeyframesFromManifest } from "./keyframe-adapter";
import { timeMapFromManifest } from "./timemap-adapter";

const SECRET = "test-secret";

describe("outputCropKeyframesFromManifest", () => {
  it("returns nothing when the manifest carries no keyframe tracks", () => {
    const manifest = signedFixtureManifest(SECRET, {
      timemap: { sourceDurationMs: 10_000, edits: [], snapCutsToFrames: false },
    });
    expect(outputCropKeyframesFromManifest(manifest, null)).toEqual([]);
  });

  it("decodes and passes source-clock keyframes through unchanged with no edits", () => {
    const packed = packKeyframesBase64([
      { tMs: 0, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { tMs: 1_000, rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } },
    ]);
    const manifest = signedFixtureManifest(SECRET, {
      timemap: {
        sourceDurationMs: 10_000,
        edits: [],
        snapCutsToFrames: false,
        keyframes: [{ itemId: "01ARZ3NDEKTSV4RRFFQ69G5FA2", kind: "reframe", packed }],
      },
    });
    const result = outputCropKeyframesFromManifest(manifest, null);
    expect(result).toHaveLength(2);
    expect(result[0]?.tMs).toBe(0);
    expect(result[1]?.tMs).toBe(1_000);
    expect(result[1]?.rect.w).toBeCloseTo(0.5, 4);
  });

  it("shifts keyframes after a cut onto the output clock", () => {
    const packed = packKeyframesBase64([
      { tMs: 0, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { tMs: 6_000, rect: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } },
    ]);
    const manifest = signedFixtureManifest(SECRET, {
      timemap: {
        sourceDurationMs: 10_000,
        edits: [{ kind: "cut", startMs: 2_000, endMs: 5_000 }],
        snapCutsToFrames: false,
        keyframes: [{ itemId: "01ARZ3NDEKTSV4RRFFQ69G5FA2", kind: "reframe", packed }],
      },
    });
    const timeMap = timeMapFromManifest(manifest);
    const result = outputCropKeyframesFromManifest(manifest, timeMap);
    // Source 6000ms, after a [2000,5000) cut (3000ms removed), lands at output 3000ms.
    const last = result[result.length - 1];
    expect(last?.tMs).toBe(3_000);
  });
});
