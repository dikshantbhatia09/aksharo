import { describe, expect, it } from "vitest";

import { graceUntil, periodEnd, renewalInitiateAt } from "./schedule.js";

describe("periodEnd", () => {
  const start = new Date("2026-01-15T00:00:00.000Z");

  it("month adds one calendar month", () => {
    expect(periodEnd(start, "month").toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });

  it("halfyear adds six calendar months (D05 split)", () => {
    expect(periodEnd(start, "halfyear").toISOString()).toBe("2026-07-15T00:00:00.000Z");
  });

  it("year adds twelve months — the customer keeps the full year even though only 10 are charged", () => {
    expect(periodEnd(start, "year").toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });

  it("once is a fixed 30 days", () => {
    expect(periodEnd(start, "once").toISOString()).toBe("2026-02-14T00:00:00.000Z");
  });

  it("two consecutive halfyear periods cover exactly one year (acceptance criterion: halfyear two-period schedule)", () => {
    const firstEnd = periodEnd(start, "halfyear");
    const secondEnd = periodEnd(firstEnd, "halfyear");
    expect(secondEnd.toISOString()).toBe(periodEnd(start, "year").toISOString());
  });
});

describe("renewalInitiateAt", () => {
  it("is 48 hours before period end (D40: 24h RBI notice + headroom)", () => {
    const end = new Date("2026-02-15T00:00:00.000Z");
    expect(renewalInitiateAt(end).toISOString()).toBe("2026-02-13T00:00:00.000Z");
  });
});

describe("graceUntil", () => {
  it("is 3 days after period end (D40 entitlement grace)", () => {
    const end = new Date("2026-02-15T00:00:00.000Z");
    expect(graceUntil(end).toISOString()).toBe("2026-02-18T00:00:00.000Z");
  });
});
