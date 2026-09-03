import { describe, expect, it } from "vitest";

import { alignCutBoundariesToBeats, beatTimesInRange } from "./beats.js";

describe("beatTimesInRange", () => {
  it("lists every beat instant inside the range, inclusive", () => {
    // 120 BPM = 500ms/beat, anchored at 0.
    expect(beatTimesInRange(120, 0, 2_000)).toEqual([0, 500, 1_000, 1_500, 2_000]);
  });

  it("respects a non-zero anchor (grid phase)", () => {
    expect(beatTimesInRange(120, 0, 1_000, 250)).toEqual([250, 750]);
  });

  it("is empty for a degenerate range or non-positive bpm", () => {
    expect(beatTimesInRange(120, 1_000, 500)).toEqual([]);
    expect(beatTimesInRange(0, 0, 1_000)).toEqual([]);
  });
});

describe("alignCutBoundariesToBeats", () => {
  const BPM = 120; // 500ms/beat

  it("snaps a boundary to the nearest beat within tolerance", () => {
    const adjustments = alignCutBoundariesToBeats(
      [{ itemId: "a", startMs: 490, endMs: 1_020 }],
      { bpm: BPM },
    );
    expect(adjustments).toEqual([
      { itemId: "a", field: "startMs", fromMs: 490, toMs: 500 },
      { itemId: "a", field: "endMs", fromMs: 1_020, toMs: 1_000 },
    ]);
  });

  it("leaves a boundary alone when the nearest beat exceeds the tolerance", () => {
    // Nearest beat to 620 is 500 (120 away, > default 120ms tolerance is exactly
    // at the edge) -- use 640 so the gap (140ms) is unambiguously over.
    const adjustments = alignCutBoundariesToBeats([{ itemId: "a", startMs: 640, endMs: 640 }], {
      bpm: BPM,
    });
    expect(adjustments).toEqual([]);
  });

  it("snaps exactly at the tolerance boundary (inclusive)", () => {
    const adjustments = alignCutBoundariesToBeats([{ itemId: "a", startMs: 620, endMs: 621 }], {
      bpm: BPM,
      toleranceMs: 120,
    });
    expect(adjustments).toEqual([{ itemId: "a", field: "startMs", fromMs: 620, toMs: 500 }]);
  });

  it("produces no adjustment for a boundary already on a beat", () => {
    const adjustments = alignCutBoundariesToBeats([{ itemId: "a", startMs: 500, endMs: 1_000 }], {
      bpm: BPM,
    });
    expect(adjustments).toEqual([]);
  });

  it("never snaps a boundary into a protected range", () => {
    const adjustments = alignCutBoundariesToBeats([{ itemId: "a", startMs: 490, endMs: 490 }], {
      bpm: BPM,
      protectedRanges: [[400, 600]],
    });
    // The nearest beat (500) sits inside [400,600] -- dropped, not clamped.
    expect(adjustments).toEqual([]);
  });

  it("respects a non-default anchor phase", () => {
    const adjustments = alignCutBoundariesToBeats([{ itemId: "a", startMs: 240, endMs: 1_000 }], {
      bpm: BPM,
      anchorMs: 250,
    });
    expect(adjustments).toEqual([{ itemId: "a", field: "startMs", fromMs: 240, toMs: 250 }]);
  });

  it("returns nothing for a non-positive bpm", () => {
    expect(alignCutBoundariesToBeats([{ itemId: "a", startMs: 490, endMs: 490 }], { bpm: 0 })).toEqual(
      [],
    );
  });
});
