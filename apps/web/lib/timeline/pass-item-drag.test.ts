import { describe, expect, it } from "vitest";

import { clampPassItemEdge, resolvePassItemDrag } from "./pass-item-drag.js";

describe("clampPassItemEdge", () => {
  it("clamps the start edge to 0 and never crosses the end edge", () => {
    expect(clampPassItemEdge("start", -500, { startMs: 1_000, endMs: 2_000 })).toBe(0);
    expect(clampPassItemEdge("start", 1_999, { startMs: 1_000, endMs: 2_000 })).toBe(1_999);
    expect(clampPassItemEdge("start", 5_000, { startMs: 1_000, endMs: 2_000 })).toBe(1_999);
  });

  it("clamps the end edge to durationMs and never crosses the start edge", () => {
    expect(
      clampPassItemEdge("end", 50_000, { startMs: 1_000, endMs: 2_000 }, { durationMs: 20_000 }),
    ).toBe(20_000);
    expect(clampPassItemEdge("end", 500, { startMs: 1_000, endMs: 2_000 })).toBe(1_001);
  });

  it("rounds a fractional pixel-derived ms to an integer (M10: EditPassItemOpSchema rejects a float)", () => {
    // `pxToMs` (lib/timeline/coords.ts) returns `scrollMs + px * msPerPx`,
    // which is rarely a whole number — unlike a word/segment edge, a pass
    // item has no snap-to-boundary step, so this used to reach the API as
    // e.g. `22999.998779296875` and 400 (`common/validation_failed`:
    // "endMs: expected int, received number").
    expect(
      clampPassItemEdge("end", 22_999.998_779_296_875, { startMs: 10_000, endMs: 20_000 }),
    ).toBe(23_000);
    expect(Number.isInteger(clampPassItemEdge("start", 10_000.4, { startMs: 15_000, endMs: 20_000 }))).toBe(
      true,
    );
  });

  it("stops at a neighbouring accepted item on the same side", () => {
    const neighbours = [{ startMs: 5_000, endMs: 6_000 }];
    expect(clampPassItemEdge("end", 5_500, { startMs: 1_000, endMs: 2_000 }, { neighbours })).toBe(
      5_000,
    );
    expect(clampPassItemEdge("start", 500, { startMs: 6_500, endMs: 7_000 }, { neighbours })).toBe(
      6_000,
    );
  });
});

describe("resolvePassItemDrag", () => {
  it("moves only the dragged edge", () => {
    const resolved = resolvePassItemDrag("end", 2_500, { startMs: 1_000, endMs: 2_000 });
    expect(resolved).toEqual({ startMs: 1_000, endMs: 2_500 });
  });

  it("never inverts the range", () => {
    const resolved = resolvePassItemDrag("start", 10_000, { startMs: 1_000, endMs: 2_000 });
    expect(resolved.startMs).toBeLessThan(resolved.endMs);
  });
});
