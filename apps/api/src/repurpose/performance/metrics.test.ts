import { describe, expect, it } from "vitest";

import {
  MAX_COUNT,
  clampCount,
  countsOf,
  engagementRate,
  hasAnyCount,
  mergeLatest,
  readLatest,
} from "./metrics.js";

const T1 = new Date("2026-10-05T10:00:00.000Z");
const T2 = new Date("2026-10-05T12:00:00.000Z");
const T3 = new Date("2026-10-06T09:00:00.000Z");

describe("mergeLatest", () => {
  it("keeps each number with its own source and time", () => {
    const measured = mergeLatest({}, { views: 1200 }, "youtube_page", T1);
    const both = mergeLatest(measured, { likes: 80, comments: 4 }, "person", T2);
    expect(both).toEqual({
      views: { value: 1200, source: "youtube_page", at: T1.toISOString() },
      likes: { value: 80, source: "person", at: T2.toISOString() },
      comments: { value: 4, source: "person", at: T2.toISOString() },
    });
  });

  it("lets a newer reading replace an older one, whoever made it", () => {
    const typed = mergeLatest({}, { views: 1500 }, "person", T2);
    expect(mergeLatest(typed, { views: 1800 }, "postiz", T3).views).toEqual({
      value: 1800,
      source: "postiz",
      at: T3.toISOString(),
    });
  });

  it("never lets a read taken earlier undo numbers read later", () => {
    const typed = mergeLatest({}, { views: 1500 }, "person", T2);
    expect(mergeLatest(typed, { views: 900 }, "postiz", T1).views?.value).toBe(1500);
  });

  it("ignores numbers a snapshot does not have, or that are not counts", () => {
    const merged = mergeLatest({}, { views: null, likes: -1, shares: Number.NaN }, "postiz", T1);
    expect(merged).toEqual({});
  });
});

describe("readLatest", () => {
  it("drops an entry that does not read and keeps the rest", () => {
    expect(
      readLatest({
        views: { value: 10, source: "postiz", at: T1.toISOString() },
        likes: { value: "ten", source: "postiz", at: T1.toISOString() },
        shares: { value: 3, source: "carrier-pigeon", at: T1.toISOString() },
        other: { value: 1, source: "postiz", at: T1.toISOString() },
      }),
    ).toEqual({ views: { value: 10, source: "postiz", at: T1.toISOString() } });
    expect(readLatest(null)).toEqual({});
    expect(readLatest([1, 2])).toEqual({});
  });

  it("round-trips what mergeLatest writes", () => {
    const merged = mergeLatest({}, { views: 1, likes: 2, comments: 3, shares: 4 }, "person", T1);
    expect(readLatest(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
    expect(countsOf(merged)).toEqual({ views: 1, likes: 2, comments: 3, shares: 4 });
  });
});

describe("counts", () => {
  it("clamps to whole numbers the column holds", () => {
    expect(clampCount(12.9)).toBe(12);
    expect(clampCount(MAX_COUNT + 10)).toBe(MAX_COUNT);
    expect(clampCount(-1)).toBeNull();
    expect(clampCount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(clampCount(undefined)).toBeNull();
  });

  it("knows whether a set of numbers says anything", () => {
    expect(hasAnyCount({})).toBe(false);
    expect(hasAnyCount({ views: null, likes: -3 })).toBe(false);
    expect(hasAnyCount({ comments: 0 })).toBe(true);
  });
});

describe("engagementRate", () => {
  it("is likes, comments and shares per view, from whichever are known", () => {
    expect(engagementRate({ views: 1000, likes: 40, comments: 5, shares: 5 })).toBeCloseTo(0.05);
    expect(engagementRate({ views: 1000, likes: 40 })).toBeCloseTo(0.04);
  });

  it("says nothing over too few views, or with nothing but views", () => {
    expect(engagementRate({ views: 99, likes: 50 })).toBeNull();
    expect(engagementRate({ views: 5000 })).toBeNull();
    expect(engagementRate({ likes: 5 })).toBeNull();
  });
});
