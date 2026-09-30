import { describe, expect, it } from "vitest";

import {
  MAX_READ_FAILURES,
  READ_WINDOW_MS,
  analyticsDays,
  nextReadAfter,
  nextReadAfterFailure,
  readEveryMs,
} from "./refresh-plan.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const POSTED = new Date("2026-10-01T12:00:00.000Z");

function at(ms: number): Date {
  return new Date(POSTED.getTime() + ms);
}

describe("readEveryMs", () => {
  it("reads a new post every six hours, a week-old one daily, an older one every three days", () => {
    expect(readEveryMs(0)).toBe(6 * HOUR);
    expect(readEveryMs(47 * HOUR)).toBe(6 * HOUR);
    expect(readEveryMs(2 * DAY)).toBe(DAY);
    expect(readEveryMs(6 * DAY)).toBe(DAY);
    expect(readEveryMs(7 * DAY)).toBe(3 * DAY);
    expect(readEveryMs(29 * DAY)).toBe(3 * DAY);
  });
});

describe("nextReadAfter", () => {
  it("follows the tiers as the post ages", () => {
    expect(nextReadAfter(POSTED, at(HOUR))).toEqual(at(7 * HOUR));
    expect(nextReadAfter(POSTED, at(3 * DAY))).toEqual(at(4 * DAY));
    expect(nextReadAfter(POSTED, at(10 * DAY))).toEqual(at(13 * DAY));
  });

  it("takes one last read at the month, then stops", () => {
    expect(nextReadAfter(POSTED, at(29 * DAY))).toEqual(at(READ_WINDOW_MS));
    expect(nextReadAfter(POSTED, at(READ_WINDOW_MS))).toBeNull();
    // A post first heard of long after it went out is read once.
    expect(nextReadAfter(POSTED, at(60 * DAY))).toBeNull();
  });

  it("reads each post about twenty times over its month", () => {
    let reads = 1;
    let next = nextReadAfter(POSTED, POSTED);
    while (next !== null) {
      reads += 1;
      next = nextReadAfter(POSTED, next);
    }
    expect(reads).toBeGreaterThanOrEqual(18);
    expect(reads).toBeLessThanOrEqual(22);
  });
});

describe("nextReadAfterFailure", () => {
  it("backs off, doubling per failure in a row, up to a day", () => {
    const now = at(DAY);
    expect(nextReadAfterFailure(POSTED, now, 1)).toEqual(new Date(now.getTime() + HOUR));
    expect(nextReadAfterFailure(POSTED, now, 2)).toEqual(new Date(now.getTime() + 2 * HOUR));
    expect(nextReadAfterFailure(POSTED, now, 4)).toEqual(new Date(now.getTime() + 8 * HOUR));
  });

  it("gives up after too many in a row, or past the month", () => {
    expect(nextReadAfterFailure(POSTED, at(DAY), MAX_READ_FAILURES)).toBeNull();
    expect(nextReadAfterFailure(POSTED, at(READ_WINDOW_MS + HOUR), 1)).toBeNull();
    expect(nextReadAfterFailure(POSTED, at(READ_WINDOW_MS - HOUR), 3)).toEqual(at(READ_WINDOW_MS));
  });
});

describe("analyticsDays", () => {
  it("asks for the shortest window that covers the post's life", () => {
    expect(analyticsDays(POSTED, at(HOUR))).toBe(7);
    expect(analyticsDays(POSTED, at(10 * DAY))).toBe(30);
    expect(analyticsDays(POSTED, at(31 * DAY))).toBe(90);
  });
});
