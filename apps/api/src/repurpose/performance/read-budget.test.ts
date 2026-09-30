import { describe, expect, it } from "vitest";

import {
  DEFAULT_POSTIZ_READS_PER_HOUR,
  MAX_POSTIZ_READS_PER_HOUR,
  postizReadsPerHour,
} from "./performance.constants.js";
import { ReadBudget } from "./read-budget.js";

const HOUR = 60 * 60_000;

describe("ReadBudget", () => {
  it("allows so many reads in any hour, and more as the hour moves on", () => {
    let now = 0;
    const budget = new ReadBudget(2, () => now);
    expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, false]);
    expect(budget.used).toBe(2);
    now += HOUR - 1;
    expect(budget.take()).toBe(false);
    now += 1;
    expect(budget.take()).toBe(true);
  });

  it("waits out a pause, and never lets an earlier one shorten a later one", () => {
    let now = 0;
    const budget = new ReadBudget(10, () => now);
    budget.pauseUntil(30 * 60_000);
    budget.pauseUntil(10 * 60_000);
    expect(budget.pausedUntil).toBe(30 * 60_000);
    now = 29 * 60_000;
    expect(budget.take()).toBe(false);
    now = 30 * 60_000;
    expect(budget.pausedUntil).toBeNull();
    expect(budget.take()).toBe(true);
  });

  it("reads nothing at all with an allowance of none", () => {
    expect(new ReadBudget(0).take()).toBe(false);
  });
});

describe("postizReadsPerHour", () => {
  it("reads the operator's number, within bounds, and a default otherwise", () => {
    expect(postizReadsPerHour({})).toBe(DEFAULT_POSTIZ_READS_PER_HOUR);
    expect(postizReadsPerHour({ PERFORMANCE_POSTIZ_READS_PER_HOUR: "3" })).toBe(3);
    expect(postizReadsPerHour({ PERFORMANCE_POSTIZ_READS_PER_HOUR: "0" })).toBe(0);
    expect(postizReadsPerHour({ PERFORMANCE_POSTIZ_READS_PER_HOUR: "25" })).toBe(
      MAX_POSTIZ_READS_PER_HOUR,
    );
    expect(postizReadsPerHour({ PERFORMANCE_POSTIZ_READS_PER_HOUR: "-2" })).toBe(
      DEFAULT_POSTIZ_READS_PER_HOUR,
    );
    expect(postizReadsPerHour({ PERFORMANCE_POSTIZ_READS_PER_HOUR: "many" })).toBe(
      DEFAULT_POSTIZ_READS_PER_HOUR,
    );
  });
});
