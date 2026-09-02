import { describe, expect, it } from "vitest";

import {
  allocateLots,
  compareLotsForConsumption,
  giveBackLots,
  mergeAllocations,
  proportionalSplit,
} from "./lot-allocation.js";

import type { AllocatableLot } from "./lot-allocation.js";

const DAY = 24 * 60 * 60 * 1000;
const base = new Date("2026-09-01T00:00:00.000Z");

function lot(
  id: string,
  remainingTenths: number,
  expiresAt: Date | null,
  createdAt: Date = base,
): AllocatableLot {
  return { id, remainingTenths, expiresAt, createdAt };
}

describe("compareLotsForConsumption", () => {
  it("orders soonest-expiring first", () => {
    const soon = lot("a", 10, new Date(base.getTime() + DAY));
    const later = lot("b", 10, new Date(base.getTime() + 2 * DAY));
    expect(compareLotsForConsumption(soon, later)).toBeLessThan(0);
    expect(compareLotsForConsumption(later, soon)).toBeGreaterThan(0);
  });

  it("puts a lot with no expiry after every expiring lot", () => {
    const expiring = lot("a", 10, new Date(base.getTime() + DAY));
    const neverExpires = lot("b", 10, null);
    expect(compareLotsForConsumption(expiring, neverExpires)).toBeLessThan(0);
  });

  it("breaks ties on createdAt, then id", () => {
    const earlier = lot("z", 10, null, base);
    const later = lot("a", 10, null, new Date(base.getTime() + 1));
    expect(compareLotsForConsumption(earlier, later)).toBeLessThan(0);

    const sameTime1 = lot("a", 10, null, base);
    const sameTime2 = lot("b", 10, null, base);
    expect(compareLotsForConsumption(sameTime1, sameTime2)).toBeLessThan(0);
    expect(compareLotsForConsumption(sameTime2, sameTime1)).toBeGreaterThan(0);
  });
});

describe("allocateLots", () => {
  it("draws from a single lot when it covers the amount", () => {
    const lots = [lot("a", 100, null)];
    const plan = allocateLots(lots, 40);
    expect(plan).toEqual({
      allocations: [{ lotId: "a", tenths: 40 }],
      fullyCovered: true,
      shortfallTenths: 0,
    });
  });

  it("consumes the soonest-expiring lot first, then FIFO", () => {
    const lots = [
      lot("no-expiry-old", 50, null, base),
      lot("expires-soon", 30, new Date(base.getTime() + DAY)),
      lot("no-expiry-new", 50, null, new Date(base.getTime() + 5000)),
      lot("expires-later", 30, new Date(base.getTime() + 2 * DAY)),
    ];
    const plan = allocateLots(lots, 90);
    expect(plan.allocations).toEqual([
      { lotId: "expires-soon", tenths: 30 },
      { lotId: "expires-later", tenths: 30 },
      { lotId: "no-expiry-old", tenths: 30 },
    ]);
    expect(plan.fullyCovered).toBe(true);
  });

  it("skips lots with nothing remaining", () => {
    const lots = [lot("empty", 0, null), lot("full", 20, null)];
    const plan = allocateLots(lots, 10);
    expect(plan.allocations).toEqual([{ lotId: "full", tenths: 10 }]);
  });

  it("reports a shortfall when the lots cannot cover the amount", () => {
    const lots = [lot("a", 10, null), lot("b", 5, null)];
    const plan = allocateLots(lots, 30);
    expect(plan.fullyCovered).toBe(false);
    expect(plan.shortfallTenths).toBe(15);
    expect(plan.allocations).toEqual([
      { lotId: "a", tenths: 10 },
      { lotId: "b", tenths: 5 },
    ]);
  });

  it("allocates nothing for a zero amount", () => {
    const plan = allocateLots([lot("a", 10, null)], 0);
    expect(plan).toEqual({ allocations: [], fullyCovered: true, shortfallTenths: 0 });
  });

  it("rejects a negative or non-integer amount", () => {
    expect(() => allocateLots([], -1)).toThrow(RangeError);
    expect(() => allocateLots([], 1.5)).toThrow(RangeError);
  });

  it("never allocates more than the lots hold in total", () => {
    const lots = [lot("a", 3, null), lot("b", 4, null)];
    const plan = allocateLots(lots, 100);
    const total = plan.allocations.reduce((sum, x) => sum + x.tenths, 0);
    expect(total).toBe(7);
    expect(plan.shortfallTenths).toBe(93);
  });
});

describe("giveBackLots", () => {
  const allocations = [
    { lotId: "a", tenths: 10 },
    { lotId: "b", tenths: 20 },
  ];

  it("gives everything back when tenths equals the total", () => {
    expect(giveBackLots(allocations, 30)).toEqual([
      { lotId: "b", tenths: 20 },
      { lotId: "a", tenths: 10 },
    ]);
  });

  it("gives back from the last-drawn lot first", () => {
    expect(giveBackLots(allocations, 5)).toEqual([{ lotId: "b", tenths: 5 }]);
  });

  it("spills into the earlier lot once the last one is exhausted", () => {
    expect(giveBackLots(allocations, 25)).toEqual([
      { lotId: "b", tenths: 20 },
      { lotId: "a", tenths: 5 },
    ]);
  });

  it("gives back nothing for zero", () => {
    expect(giveBackLots(allocations, 0)).toEqual([]);
  });

  it("refuses to give back more than was ever taken", () => {
    expect(() => giveBackLots(allocations, 31)).toThrow(RangeError);
  });

  it("rejects a negative or non-integer amount", () => {
    expect(() => giveBackLots(allocations, -1)).toThrow(RangeError);
    expect(() => giveBackLots(allocations, 1.5)).toThrow(RangeError);
  });
});

describe("mergeAllocations", () => {
  it("sums tenths for the same lot across both lists", () => {
    const a = [{ lotId: "x", tenths: 5 }];
    const b = [
      { lotId: "x", tenths: 3 },
      { lotId: "y", tenths: 7 },
    ];
    const merged = mergeAllocations(a, b);
    expect(merged).toHaveLength(2);
    expect(merged.find((m) => m.lotId === "x")?.tenths).toBe(8);
    expect(merged.find((m) => m.lotId === "y")?.tenths).toBe(7);
  });

  it("returns an empty list for two empty inputs", () => {
    expect(mergeAllocations([], [])).toEqual([]);
  });
});

describe("proportionalSplit", () => {
  it("splits proportionally and sums exactly to the amount", () => {
    const allocations = [
      { lotId: "a", tenths: 30 },
      { lotId: "b", tenths: 70 },
    ];
    const shares = proportionalSplit(allocations, 10);
    expect(shares.reduce((sum, s) => sum + s.tenths, 0)).toBe(10);
    expect(shares).toEqual([
      { lotId: "a", tenths: 3 },
      { lotId: "b", tenths: 7 },
    ]);
  });

  it("puts the rounding remainder on the last entry", () => {
    const allocations = [
      { lotId: "a", tenths: 1 },
      { lotId: "b", tenths: 1 },
      { lotId: "c", tenths: 1 },
    ];
    const shares = proportionalSplit(allocations, 10);
    expect(shares.reduce((sum, s) => sum + s.tenths, 0)).toBe(10);
    // floor(10/3) = 3 for the first two, remainder 4 to the last.
    expect(shares).toEqual([
      { lotId: "a", tenths: 3 },
      { lotId: "b", tenths: 3 },
      { lotId: "c", tenths: 4 },
    ]);
  });

  it("gives everything to a single allocation", () => {
    expect(proportionalSplit([{ lotId: "a", tenths: 5 }], 25)).toEqual([
      { lotId: "a", tenths: 25 },
    ]);
  });

  it("returns nothing for an empty allocation list", () => {
    expect(proportionalSplit([], 10)).toEqual([]);
  });

  it("returns nothing for a zero amount", () => {
    expect(proportionalSplit([{ lotId: "a", tenths: 5 }], 0)).toEqual([{ lotId: "a", tenths: 0 }]);
  });

  it("rejects a negative or non-integer amount", () => {
    expect(() => proportionalSplit([{ lotId: "a", tenths: 5 }], -1)).toThrow(RangeError);
    expect(() => proportionalSplit([{ lotId: "a", tenths: 5 }], 1.5)).toThrow(RangeError);
  });
});
