import { describe, expect, it } from "vitest";

import { signedFixtureManifest } from "@montaj/render-manifest/testing";

import { outputDurationMsFor, timeMapFromManifest } from "./timemap-adapter";

const SECRET = "test-secret";

describe("timeMapFromManifest / outputDurationMsFor", () => {
  it("returns the source duration untouched when there are no edits", () => {
    const manifest = signedFixtureManifest(SECRET, {
      timemap: { sourceDurationMs: 12_000, edits: [], snapCutsToFrames: false },
    });
    expect(outputDurationMsFor(manifest)).toBe(12_000);
  });

  it("applies a cut and shortens the output duration", () => {
    const manifest = signedFixtureManifest(SECRET, {
      timemap: {
        sourceDurationMs: 12_000,
        edits: [{ kind: "cut", startMs: 2_000, endMs: 5_000 }],
        snapCutsToFrames: false,
      },
    });
    expect(outputDurationMsFor(manifest)).toBe(9_000);
    const timemap = timeMapFromManifest(manifest);
    expect(timemap.toOutput(1_000)).toBe(1_000);
    expect(timemap.toOutput(3_500)).toBeNull();
    expect(timemap.toOutput(6_000)).toBe(3_000);
  });
});
