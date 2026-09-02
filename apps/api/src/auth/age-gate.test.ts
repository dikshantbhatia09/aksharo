import { describe, expect, it } from "vitest";

import { ageInYears, evaluateAgeGate, isPlausibleDateOfBirth, MINIMUM_AGE } from "./age-gate.js";

const NOW = new Date("2026-09-02T00:00:00.000Z");

/** A date of birth that makes someone exactly `years` old on {@link NOW}. */
function bornYearsAgo(years: number, offsetDays = 0): Date {
  const dob = new Date(NOW);
  dob.setUTCFullYear(dob.getUTCFullYear() - years);
  dob.setUTCDate(dob.getUTCDate() + offsetDays);
  return dob;
}

describe("ageInYears", () => {
  it("does not count a birthday that has not happened yet this year", () => {
    expect(ageInYears(new Date("2008-09-03T00:00:00.000Z"), NOW)).toBe(17);
    expect(ageInYears(new Date("2008-09-02T00:00:00.000Z"), NOW)).toBe(18);
  });

  it("handles a 29 February birth date", () => {
    expect(ageInYears(new Date("2008-02-29T00:00:00.000Z"), NOW)).toBe(18);
  });
});

describe("evaluateAgeGate (D60)", () => {
  it("blocks an Indian 17-year-old", () => {
    const verdict = evaluateAgeGate({
      dateOfBirth: bornYearsAgo(17),
      jurisdiction: "IN",
      now: NOW,
    });
    expect(verdict).toMatchObject({ allowed: false, ageBracket: "minor", minimumAge: 18 });
  });

  it("allows an Indian 18-year-old", () => {
    const verdict = evaluateAgeGate({
      dateOfBirth: bornYearsAgo(18),
      jurisdiction: "IN",
      now: NOW,
    });
    expect(verdict).toMatchObject({ allowed: true, ageBracket: "adult" });
  });

  it("blocks an EU 15-year-old and allows an EU 16-year-old", () => {
    expect(
      evaluateAgeGate({ dateOfBirth: bornYearsAgo(15), jurisdiction: "EU", now: NOW }).allowed,
    ).toBe(false);
    const sixteen = evaluateAgeGate({
      dateOfBirth: bornYearsAgo(16),
      jurisdiction: "EU",
      now: NOW,
    });
    // Allowed, but still a minor: D60 switches analytics and referral targeting off.
    expect(sixteen).toMatchObject({ allowed: true, ageBracket: "minor" });
  });

  it("records anyone under 18 as a minor even where sign-up is allowed", () => {
    const verdict = evaluateAgeGate({
      dateOfBirth: bornYearsAgo(16),
      jurisdiction: "OTHER",
      now: NOW,
    });
    expect(verdict).toMatchObject({ allowed: true, ageBracket: "minor" });
  });

  it("keeps the thresholds D60 fixed", () => {
    expect(MINIMUM_AGE).toEqual({ IN: 18, EU: 16, OTHER: 0 });
  });
});

describe("isPlausibleDateOfBirth", () => {
  it("rejects the future, invalid dates and impossible ages", () => {
    expect(isPlausibleDateOfBirth(new Date("2030-01-01T00:00:00.000Z"), NOW)).toBe(false);
    expect(isPlausibleDateOfBirth(new Date("not-a-date"), NOW)).toBe(false);
    expect(isPlausibleDateOfBirth(new Date("1800-01-01T00:00:00.000Z"), NOW)).toBe(false);
  });

  it("accepts an ordinary date of birth", () => {
    expect(isPlausibleDateOfBirth(new Date("1990-05-04T00:00:00.000Z"), NOW)).toBe(true);
  });
});
