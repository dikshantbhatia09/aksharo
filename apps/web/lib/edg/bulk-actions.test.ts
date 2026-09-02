import { describe, expect, it } from "vitest";

import type { Segment, Word } from "@montaj/edg";

import { planMergeShort, planSplitLong } from "./bulk-actions";

let counter = 0;
function id(): string {
  counter += 1;
  return `id-${String(counter)}`;
}

function segment(
  overrides: Partial<Segment> & { id: string; startMs: number; endMs: number },
): Segment {
  return {
    seq: overrides.id,
    startWordId: "0:0" as never,
    endWordId: "0:0" as never,
    ...overrides,
  };
}

function word(wid: string, s: number, e: number): Word {
  return { wid: wid as never, s, e, t: "w" };
}

describe("planMergeShort", () => {
  it("merges a segment shorter than the threshold into its next neighbour", () => {
    const segments = [
      segment({ id: "s1", startMs: 0, endMs: 500 }),
      segment({ id: "s2", startMs: 500, endMs: 3000 }),
    ];
    const ops = planMergeShort({ segments, newId: id });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      type: "MergeSegments",
      segmentIds: ["s1", "s2"],
      newSegmentId: "s1",
    });
  });

  it("does not merge a segment at or above the threshold", () => {
    const segments = [
      segment({ id: "s1", startMs: 0, endMs: 900 }),
      segment({ id: "s2", startMs: 900, endMs: 3000 }),
    ];
    expect(planMergeShort({ segments, thresholdMs: 900, newId: id })).toEqual([]);
  });

  it("a run of three short segments produces one merge, then continues past the pair", () => {
    const segments = [
      segment({ id: "s1", startMs: 0, endMs: 200 }),
      segment({ id: "s2", startMs: 200, endMs: 400 }),
      segment({ id: "s3", startMs: 400, endMs: 600 }),
    ];
    const ops = planMergeShort({ segments, newId: id });
    // s1 merges into s2 (index jumps past both); s3 has no next neighbour.
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ segmentIds: ["s1", "s2"] });
  });

  it("skips a hidden segment or a hidden neighbour", () => {
    const segments = [
      segment({ id: "s1", startMs: 0, endMs: 200, hidden: true }),
      segment({ id: "s2", startMs: 200, endMs: 3000 }),
    ];
    expect(planMergeShort({ segments, newId: id })).toEqual([]);
  });

  it("the last segment being short has no next neighbour to merge into", () => {
    const segments = [
      segment({ id: "s1", startMs: 0, endMs: 3000 }),
      segment({ id: "s2", startMs: 3000, endMs: 3200 }),
    ];
    expect(planMergeShort({ segments, newId: id })).toEqual([]);
  });
});

describe("planSplitLong", () => {
  it("splits a segment longer than the threshold at the word nearest its midpoint", () => {
    const seg = segment({ id: "s1", startMs: 0, endMs: 8000 });
    const words = [word("0:0", 0, 1000), word("0:1", 3900, 4100), word("0:2", 7000, 8000)];
    const ops = planSplitLong({ segments: [seg], wordsOf: () => words, newId: id });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: "SplitSegment", segmentId: "s1", atWordId: "0:1" });
  });

  it("does not split a segment at or under the threshold", () => {
    const seg = segment({ id: "s1", startMs: 0, endMs: 5000 });
    const words = [word("0:0", 0, 1000), word("0:1", 4000, 5000)];
    expect(
      planSplitLong({ segments: [seg], wordsOf: () => words, thresholdMs: 6000, newId: id }),
    ).toEqual([]);
  });

  it("a segment with fewer than two live words cannot be split", () => {
    const seg = segment({ id: "s1", startMs: 0, endMs: 8000 });
    expect(
      planSplitLong({ segments: [seg], wordsOf: () => [word("0:0", 0, 1000)], newId: id }),
    ).toEqual([]);
  });

  it("skips hidden segments", () => {
    const seg = segment({ id: "s1", startMs: 0, endMs: 8000, hidden: true });
    const words = [word("0:0", 0, 1000), word("0:1", 4000, 5000)];
    expect(planSplitLong({ segments: [seg], wordsOf: () => words, newId: id })).toEqual([]);
  });
});
