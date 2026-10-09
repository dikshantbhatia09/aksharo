import { describe, expect, it } from "vitest";

import { formatClock, formatClockMs, parseClock, validateMoment } from "./moment-time";

describe("parseClock", () => {
  it("reads m:ss, h:mm:ss, and millisecond timecodes mm:ss.mmm", () => {
    expect(parseClock("1:05")).toBe(65_000);
    expect(parseClock("01:05")).toBe(65_000);
    expect(parseClock(" 0:03 ")).toBe(3_000);
    expect(parseClock("75:30")).toBe(4_530_000);
    expect(parseClock("1:02:03")).toBe(3_723_000);
    expect(parseClock("04:15.000")).toBe(255_000);
    expect(parseClock("05:02.500")).toBe(302_500);
    expect(parseClock("1:02:03.25")).toBe(3_723_250);
  });

  it("refuses anything it would have to guess at", () => {
    for (const raw of ["", "65", "1:5", "1:60", "1:60:00", "a:bc", "1.05", "-1:00"]) {
      expect(parseClock(raw), raw).toBeNull();
    }
  });
});

describe("formatClock & formatClockMs", () => {
  it("writes m:ss, and h:mm:ss past the hour", () => {
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(3_723_000)).toBe("1:02:03");
  });

  it("writes mm:ss.mmm and hh:mm:ss.mmm for frame-accurate timecodes", () => {
    expect(formatClockMs(255_000)).toBe("04:15.000");
    expect(formatClockMs(302_500)).toBe("05:02.500");
    expect(formatClockMs(3_723_250)).toBe("01:02:03.250");
  });
});

describe("validateMoment", () => {
  it("accepts a 3 s to 3 min range inside the video", () => {
    expect(validateMoment("1:00", "1:30", 600_000)).toEqual({
      problems: {},
      range: { startMs: 60_000, endMs: 90_000 },
    });
    expect(validateMoment("0:00", "0:03", null).range).toEqual({ startMs: 0, endMs: 3_000 });
    expect(validateMoment("0:00", "3:00", undefined).range).toEqual({ startMs: 0, endMs: 180_000 });
  });

  it("names the field that cannot be read", () => {
    const { problems, range } = validateMoment("one", "1:30", null);
    expect(problems.start).toBeDefined();
    expect(problems.end).toBeUndefined();
    expect(range).toBeUndefined();
  });

  it("holds the contract's bounds", () => {
    expect(validateMoment("1:00", "1:00", null).problems.end).toMatch(/after the start/);
    expect(validateMoment("1:00", "1:02", null).problems.end).toMatch(/at least 3 seconds/);
    expect(validateMoment("0:00", "3:01", null).problems.end).toMatch(/at most 3 minutes/);
  });

  it("keeps the moment inside the video when its length is known", () => {
    expect(validateMoment("9:50", "10:20", 600_000).problems.end).toMatch(/ends at 10:00/);
    expect(validateMoment("10:10", "10:20", 600_000).problems.start).toMatch(/only 10:00 long/);
    // Unknown length: the API is the only check on the upper end.
    expect(validateMoment("9:50", "10:20", 0).range).toBeDefined();
  });
});
