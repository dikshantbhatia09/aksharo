import { describe, expect, it } from "vitest";

import {
  assignHoldout,
  creditGrantTenthsForLevel,
  currentWeekWindow,
  discountPercentForLevel,
  initialState,
  isoDateInZone,
  previousWeekWindow,
  resetFreezesForNewMonth,
  rolloverWeek,
  type StreakState,
} from "./streak.engine.js";

const paid = (overrides: Partial<StreakState> = {}): StreakState => ({
  level: 1,
  consecutiveWeeks: 0,
  freezesRemaining: 2,
  paused: false,
  creditsOnly: false,
  ...overrides,
});

describe("rolloverWeek — table tests", () => {
  it("kept week (>= 3 publish days) advances the counter, stays L1", () => {
    const result = rolloverWeek(paid(), 3, false);
    expect(result.outcome).toBe("kept");
    expect(result.next).toEqual(paid({ consecutiveWeeks: 1 }));
    expect(result.leveledUpTo).toBeUndefined();
  });

  it("missed week with a freeze available consumes one freeze, streak unaffected", () => {
    const result = rolloverWeek(paid({ consecutiveWeeks: 2 }), 1, false);
    expect(result.outcome).toBe("froze");
    expect(result.next).toEqual(paid({ consecutiveWeeks: 2, freezesRemaining: 1 }));
  });

  it("missed week with no freeze left pauses — no level change, counter resets", () => {
    const result = rolloverWeek(paid({ consecutiveWeeks: 2, freezesRemaining: 0 }), 0, false);
    expect(result.outcome).toBe("paused");
    expect(result.next).toEqual(paid({ consecutiveWeeks: 0, freezesRemaining: 0, paused: true }));
    expect(result.next.level).toBe(1);
  });

  it("a kept week while paused resumes, restarting the counter at 1, level unchanged", () => {
    const result = rolloverWeek(paid({ level: 3, paused: true, freezesRemaining: 0 }), 3, false);
    expect(result.outcome).toBe("resumed");
    expect(result.next).toEqual(paid({ level: 3, consecutiveWeeks: 1, freezesRemaining: 0 }));
  });

  it("four consecutive kept weeks levels up, then resets the counter", () => {
    let state = paid();
    for (let week = 1; week <= 3; week += 1) {
      const result = rolloverWeek(state, 3, false);
      expect(result.outcome).toBe("kept");
      expect(result.leveledUpTo).toBeUndefined();
      state = result.next;
    }
    expect(state.consecutiveWeeks).toBe(3);

    const fourth = rolloverWeek(state, 3, false);
    expect(fourth.outcome).toBe("kept");
    expect(fourth.leveledUpTo).toBe(2);
    expect(fourth.next).toEqual(paid({ level: 2, consecutiveWeeks: 0 }));
  });

  it("a level never decreases across any transition, including a pause", () => {
    const atLevel3 = paid({ level: 3, freezesRemaining: 0 });
    const missed = rolloverWeek(atLevel3, 0, false);
    expect(missed.next.level).toBeGreaterThanOrEqual(3);
    const resumedThenMissed = rolloverWeek(missed.next, 0, false);
    expect(resumedThenMissed.next.level).toBeGreaterThanOrEqual(3);
  });

  it("caps at L5 — a fifth level-up tick does not overflow", () => {
    const atMax = paid({ level: 5, consecutiveWeeks: 3 });
    const result = rolloverWeek(atMax, 3, false);
    expect(result.next.level).toBe(5);
    expect(result.leveledUpTo).toBeUndefined(); // already at the max, nothing to report
  });

  it("resetFreezesForNewMonth restores the monthly allowance regardless of remainder", () => {
    expect(resetFreezesForNewMonth(paid({ freezesRemaining: 0 })).freezesRemaining).toBe(2);
    expect(resetFreezesForNewMonth(paid({ freezesRemaining: 1 })).freezesRemaining).toBe(2);
  });
});

describe("Free credits-only streak", () => {
  const free = (overrides: Partial<StreakState> = {}): StreakState => ({
    ...paid(overrides),
    creditsOnly: true,
    level: 1,
  });

  it("two consecutive kept weeks fires the reward and resets the counter", () => {
    const week1 = rolloverWeek(free(), 3, true);
    expect(week1.freeCreditReward).toBe(false);
    expect(week1.next.consecutiveWeeks).toBe(1);

    const week2 = rolloverWeek(week1.next, 3, true);
    expect(week2.freeCreditReward).toBe(true);
    expect(week2.next.consecutiveWeeks).toBe(0);
    expect(week2.next.level).toBe(1); // Free never levels up
  });

  it("never carries a discount or credit-grant level regardless of streak length", () => {
    let state = free();
    for (let i = 0; i < 10; i += 1) state = rolloverWeek(state, 3, true).next;
    expect(state.level).toBe(1);
    expect(discountPercentForLevel(state.level)).toBeUndefined();
    expect(creditGrantTenthsForLevel(state.level)).toBeUndefined();
  });
});

describe("rolloverWeek — plan change mid-streak (B06b)", () => {
  it("downgrade to Free mid-streak: no L4 lot even on a week that would have leveled up", () => {
    // L3, 3 consecutive kept weeks (one more kept week would level to L4 on
    // the paid track) — but the plan read this tick says Free.
    const atL3 = paid({ level: 3, consecutiveWeeks: 3, freezesRemaining: 2 });
    const result = rolloverWeek(atL3, 3, true);
    expect(result.next.creditsOnly).toBe(true);
    expect(result.next.level).toBe(3); // unchanged, never decreases
    expect(result.leveledUpTo).toBeUndefined(); // no L4 lot
    expect(result.next.consecutiveWeeks).toBe(1); // counter reset (0) then this kept week counted
    expect(discountPercentForLevel(result.next.level)).toBe(10); // level still "carries" 10%...
    // ...but the service never reads it: getDiscountPercent short-circuits on creditsOnly.
  });

  it("downgrade mid-streak: the +5 credits Free rule applies going forward", () => {
    const atL3 = paid({ level: 3, consecutiveWeeks: 3, freezesRemaining: 2 });
    const downgraded = rolloverWeek(atL3, 3, true); // this tick: flip + reset to 1
    const nextKept = rolloverWeek(downgraded.next, 3, true); // second Free-tracked kept week
    expect(nextKept.freeCreditReward).toBe(true);
    expect(nextKept.next.level).toBe(3); // level still never decreases
  });

  it("downgrade mid-streak on a missed week: still flips creditsOnly, applies the missed-week rule", () => {
    const atL2 = paid({ level: 2, consecutiveWeeks: 2, freezesRemaining: 0 });
    const result = rolloverWeek(atL2, 0, true);
    expect(result.next.creditsOnly).toBe(true);
    expect(result.outcome).toBe("paused");
    expect(result.next.consecutiveWeeks).toBe(0);
  });

  it("upgrade after downgrade: the counter resets again and paid progression resumes", () => {
    const atL3 = paid({ level: 3, consecutiveWeeks: 3, freezesRemaining: 2 });
    const downgraded = rolloverWeek(atL3, 3, true);
    expect(downgraded.next.creditsOnly).toBe(true);

    const upgraded = rolloverWeek(downgraded.next, 3, false);
    expect(upgraded.next.creditsOnly).toBe(false);
    expect(upgraded.next.level).toBe(3); // unchanged across both flips
    expect(upgraded.next.consecutiveWeeks).toBe(1); // reset, then this kept week counted
    expect(discountPercentForLevel(upgraded.next.level)).toBe(10); // discount restored at L3
  });

  it("no flip: planIsFree matching the stored creditsOnly is a no-op on the counter", () => {
    const atL2 = paid({ level: 2, consecutiveWeeks: 1 });
    const result = rolloverWeek(atL2, 3, false);
    expect(result.next.consecutiveWeeks).toBe(2); // simple increment, no reset
  });
});

describe("initialState", () => {
  it("starts a monthly subscriber at L1", () => {
    expect(initialState({ yearly: false, creditsOnly: false }).level).toBe(1);
  });

  it("starts a yearly subscriber at L4 (D52)", () => {
    expect(initialState({ yearly: true, creditsOnly: false }).level).toBe(4);
  });

  it("a Free (creditsOnly) workspace always starts at L1 even if flagged yearly", () => {
    expect(initialState({ yearly: true, creditsOnly: true }).level).toBe(1);
  });
});

describe("reward lookups", () => {
  it("L2/L3 carry a renewal discount, within the mandate cap", () => {
    expect(discountPercentForLevel(2)).toBe(5);
    expect(discountPercentForLevel(3)).toBe(10);
    expect(discountPercentForLevel(1)).toBeUndefined();
    expect(discountPercentForLevel(4)).toBeUndefined();
  });

  it("L4/L5 carry a monthly credit grant, expiring with the period", () => {
    expect(creditGrantTenthsForLevel(4)).toBe(500);
    expect(creditGrantTenthsForLevel(5)).toBe(1000);
    expect(creditGrantTenthsForLevel(3)).toBeUndefined();
  });
});

describe("assignHoldout — deterministic 50/50 by workspace id", () => {
  it("is stable for the same workspace id across calls", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(assignHoldout(id)).toBe(assignHoldout(id));
  });

  it("splits a large sample roughly 50/50 (within a generous tolerance)", () => {
    let holdout = 0;
    const n = 2000;
    for (let i = 0; i < n; i += 1) {
      if (assignHoldout(`workspace-${String(i)}`)) holdout += 1;
    }
    const pct = holdout / n;
    expect(pct).toBeGreaterThan(0.4);
    expect(pct).toBeLessThan(0.6);
  });

  it("respects a configured percentage", () => {
    let holdout = 0;
    const n = 2000;
    for (let i = 0; i < n; i += 1) {
      if (assignHoldout(`ws-${String(i)}`, 10)) holdout += 1;
    }
    expect(holdout / n).toBeLessThan(0.2);
  });
});

describe("week window — Mon-Sun in the workspace timezone (fake clocks)", () => {
  it("a Wednesday in UTC resolves to the Monday-Sunday window containing it", () => {
    const wednesday = new Date("2026-09-02T10:00:00.000Z"); // Wed
    const window = currentWeekWindow(wednesday, "UTC");
    expect(window.start.toISOString()).toBe("2026-08-31T00:00:00.000Z"); // Monday
    expect(window.end.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  it("a Monday 00:00 is the start of its own window, not the previous one", () => {
    const monday = new Date("2026-08-31T00:00:00.000Z");
    const window = currentWeekWindow(monday, "UTC");
    expect(window.start.toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("a Sunday just before midnight is still in the same week", () => {
    const sundayLate = new Date("2026-09-06T23:59:59.000Z");
    const window = currentWeekWindow(sundayLate, "UTC");
    expect(window.start.toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("honours a non-UTC workspace timezone (IST, UTC+5:30)", () => {
    // 2026-09-02T20:00Z is 2026-09-03T01:30 IST — Thursday IST.
    const now = new Date("2026-09-02T20:00:00.000Z");
    const window = currentWeekWindow(now, "Asia/Kolkata");
    // Monday 00:00 IST = 2026-08-30T18:30:00Z.
    expect(window.start.toISOString()).toBe("2026-08-30T18:30:00.000Z");
  });

  it("previousWeekWindow steps back exactly seven days", () => {
    const window = currentWeekWindow(new Date("2026-09-02T10:00:00.000Z"), "UTC");
    const prev = previousWeekWindow(window);
    expect(prev.end.toISOString()).toBe(window.start.toISOString());
    expect(prev.start.toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });

  it("isoDateInZone renders the local calendar date", () => {
    expect(isoDateInZone(new Date("2026-09-02T20:00:00.000Z"), "Asia/Kolkata")).toBe("2026-09-03");
    expect(isoDateInZone(new Date("2026-09-02T20:00:00.000Z"), "UTC")).toBe("2026-09-02");
  });
});
