import { describe, expect, it } from "vitest";

import {
  addDays,
  dayInZone,
  isTimeZone,
  parseClock,
  planDaily,
  zonedTimeToUtc,
} from "./daily-plan.js";

const IST = "Asia/Kolkata";

describe("time zones", () => {
  it("puts 7 pm in India at 13:30 UTC", () => {
    expect(zonedTimeToUtc("2026-10-01", { hour: 19, minute: 0 }, IST).toISOString()).toBe(
      "2026-10-01T13:30:00.000Z",
    );
    expect(dayInZone(new Date("2026-10-01T20:00:00Z"), IST)).toBe("2026-10-02");
  });

  it("lands on the wall time across a change of the clocks", () => {
    // New York leaves daylight time on 1 November 2026.
    expect(
      zonedTimeToUtc("2026-11-01", { hour: 19, minute: 0 }, "America/New_York").toISOString(),
    ).toBe("2026-11-02T00:00:00.000Z");
    expect(
      zonedTimeToUtc("2026-10-31", { hour: 19, minute: 0 }, "America/New_York").toISOString(),
    ).toBe("2026-10-31T23:00:00.000Z");
  });

  it("knows a zone, a clock and the next day", () => {
    expect(isTimeZone(IST)).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(parseClock("19:00")).toEqual({ hour: 19, minute: 0 });
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("7pm")).toBeNull();
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("planDaily", () => {
  const clock = { hour: 19, minute: 0 };

  it("gives each clip its own day at 7 pm, starting today while there is time", () => {
    const slots = planDaily({
      clipIds: ["a", "b", "c"],
      channelIds: ["ig"],
      clock,
      timeZone: IST,
      now: new Date("2026-10-01T06:00:00Z"), // 11:30 in India
      usedDays: new Map(),
      minLeadMs: 15 * 60_000,
    });
    expect(slots.map((slot) => [slot.clipId, slot.at.toISOString()])).toEqual([
      ["a", "2026-10-01T13:30:00.000Z"],
      ["b", "2026-10-02T13:30:00.000Z"],
      ["c", "2026-10-03T13:30:00.000Z"],
    ]);
  });

  it("starts tomorrow once today's time has passed, and skips days an account already uses", () => {
    const slots = planDaily({
      clipIds: ["a", "b"],
      channelIds: ["ig", "yt"],
      clock,
      timeZone: IST,
      now: new Date("2026-10-01T14:00:00Z"), // 19:30 in India
      usedDays: new Map([["ig", new Set(["2026-10-02", "2026-10-04"])]]),
      minLeadMs: 15 * 60_000,
    });
    expect(slots.map((slot) => [slot.channelId, slot.clipId, dayInZone(slot.at, IST)])).toEqual([
      ["ig", "a", "2026-10-03"],
      ["ig", "b", "2026-10-05"],
      ["yt", "a", "2026-10-02"],
      ["yt", "b", "2026-10-03"],
    ]);
  });

  it("honours a start date", () => {
    const [slot] = planDaily({
      clipIds: ["a"],
      channelIds: ["ig"],
      clock: { hour: 9, minute: 30 },
      timeZone: IST,
      now: new Date("2026-10-01T06:00:00Z"),
      startDay: "2026-10-10",
      usedDays: new Map(),
      minLeadMs: 0,
    });
    expect(slot?.at.toISOString()).toBe("2026-10-10T04:00:00.000Z");
  });
});
