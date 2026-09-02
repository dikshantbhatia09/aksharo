import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  boundsAreValid,
  clampSegmentEdge,
  MIN_SEGMENT_MS,
  resolveSegmentDrag,
  segmentsOverlap,
  SNAP_TOLERANCE_MS,
  snapToBoundary,
} from "./snapping";

describe("snapToBoundary", () => {
  it("snaps within tolerance", () => {
    expect(snapToBoundary(1020, [1000, 2000])).toBe(1000);
    expect(snapToBoundary(1041, [1000, 2000])).toBe(1041); // just past 40ms
    expect(snapToBoundary(1040, [1000, 2000])).toBe(1000); // exactly at tolerance
  });
  it("picks the nearest boundary", () => {
    expect(snapToBoundary(1500, [1000, 1490, 2000])).toBe(1490);
  });
  it("leaves candidate unchanged with no boundaries", () => {
    expect(snapToBoundary(1234, [])).toBe(1234);
  });
  it("respects a custom tolerance", () => {
    expect(snapToBoundary(1010, [1000], 5)).toBe(1010);
    expect(snapToBoundary(1004, [1000], 5)).toBe(1000);
  });
});

describe("clampSegmentEdge", () => {
  const current = { startMs: 1000, endMs: 2000 };
  it("clamps start to not cross the end minus MIN_SEGMENT_MS", () => {
    expect(clampSegmentEdge("start", 2500, current)).toBe(2000 - MIN_SEGMENT_MS);
  });
  it("clamps start to the previous neighbour's end", () => {
    const prev = { startMs: 0, endMs: 500 };
    expect(clampSegmentEdge("start", 100, current, { prev })).toBe(500);
  });
  it("clamps end to not cross the start plus MIN_SEGMENT_MS", () => {
    expect(clampSegmentEdge("end", 500, current)).toBe(1000 + MIN_SEGMENT_MS);
  });
  it("clamps end to the next neighbour's start", () => {
    const next = { startMs: 2500, endMs: 3000 };
    expect(clampSegmentEdge("end", 9000, current, { next })).toBe(2500);
  });
  it("never lets start go below 0 with no previous neighbour", () => {
    expect(clampSegmentEdge("start", -500, current)).toBe(0);
  });
});

describe("resolveSegmentDrag", () => {
  const current = { startMs: 1000, endMs: 2000 };
  it("snaps then clamps", () => {
    const result = resolveSegmentDrag("start", 1010, current, { wordBoundaries: [1005] });
    expect(result).toEqual({ startMs: 1005, endMs: 2000 });
  });
  it("a snap that would overlap the previous neighbour is pulled back by the clamp", () => {
    const prev = { startMs: 0, endMs: 900 };
    const result = resolveSegmentDrag("start", 850, current, {
      wordBoundaries: [800],
      neighbours: { prev },
    });
    expect(result.startMs).toBe(900);
  });
});

describe("segmentsOverlap / boundsAreValid", () => {
  it("touching edges are not an overlap", () => {
    expect(segmentsOverlap({ startMs: 0, endMs: 100 }, { startMs: 100, endMs: 200 })).toBe(false);
  });
  it("overlapping ranges are an overlap", () => {
    expect(segmentsOverlap({ startMs: 0, endMs: 150 }, { startMs: 100, endMs: 200 })).toBe(true);
  });
  it("rejects an inverted/too-short range", () => {
    expect(boundsAreValid({ startMs: 100, endMs: 100 })).toBe(false);
    expect(boundsAreValid({ startMs: 100, endMs: 50 })).toBe(false);
  });
});

/**
 * Property test (brief §7): dragging never produces overlapping words/segments.
 * A run of adjacent segments, a random edge, a random candidate ms —
 * `resolveSegmentDrag`'s result must never overlap either neighbour and must
 * always be a valid (non-inverted, minimum-length) range.
 */
describe("property: dragging never produces overlapping or inverted bounds", () => {
  it("holds across random segment chains and drag targets", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 50, max: 5000 }), { minLength: 3, maxLength: 8 }),
        fc.integer({ min: 0, max: 7 }),
        fc.constantFrom<"start" | "end">("start", "end"),
        fc.integer({ min: -2000, max: 20_000 }),
        fc.array(fc.integer({ min: 0, max: 50_000 }), { maxLength: 5 }),
        (durations, pickIndexSeed, edge, candidateOffset, wordBoundaries) => {
          // Build a chain of adjacent, non-overlapping segments.
          const segments: { startMs: number; endMs: number }[] = [];
          let cursor = 0;
          for (const duration of durations) {
            segments.push({ startMs: cursor, endMs: cursor + duration });
            cursor += duration;
          }
          const index = pickIndexSeed % segments.length;
          const current = segments[index]!;
          const prev = segments[index - 1];
          const next = segments[index + 1];
          const candidateMs = current.startMs + candidateOffset;

          const result = resolveSegmentDrag(edge, candidateMs, current, {
            wordBoundaries,
            neighbours: { ...(prev && { prev }), ...(next && { next }) },
          });

          expect(result.endMs - result.startMs).toBeGreaterThanOrEqual(MIN_SEGMENT_MS);
          if (prev !== undefined) expect(segmentsOverlap(result, prev)).toBe(false);
          if (next !== undefined) expect(segmentsOverlap(result, next)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });
});

it("SNAP_TOLERANCE_MS is the brief's 40ms", () => {
  expect(SNAP_TOLERANCE_MS).toBe(40);
});
