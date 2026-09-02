import { describe, expect, it } from "vitest";

import { ageInYears, evaluateAge, JURISDICTIONS, MINIMUM_AGE } from "./age-gate";

const TODAY = new Date("2026-09-02T00:00:00.000Z");

describe("ageInYears", () => {
  it("counts whole years", () => {
    expect(ageInYears("2000-09-02", TODAY)).toBe(26);
    expect(ageInYears("2000-09-03", TODAY)).toBe(25);
  });

  it("rejects a malformed, impossible or future date", () => {
    expect(ageInYears("02-09-2000", TODAY)).toBeNull();
    expect(ageInYears("2001-02-30", TODAY)).toBeNull();
    expect(ageInYears("2030-01-01", TODAY)).toBeNull();
  });
});

describe("evaluateAge (D60)", () => {
  it("blocks under-18s in India", () => {
    expect(evaluateAge("2010-01-01", "IN", TODAY)).toEqual({
      valid: true,
      age: 16,
      blocked: true,
      minor: true,
    });
  });

  it("allows a 16-year-old in the EU but still marks them a minor", () => {
    expect(evaluateAge("2010-01-01", "EU", TODAY)).toEqual({
      valid: true,
      age: 16,
      blocked: false,
      minor: true,
    });
  });

  it("declares no floor elsewhere, exactly as the API does", () => {
    // D60 names a minimum for India and the EU only; inventing one here would
    // reject sign-ups the server accepts.
    expect(evaluateAge("2015-01-01", "OTHER", TODAY).blocked).toBe(false);
    expect(evaluateAge("2015-01-01", "OTHER", TODAY).minor).toBe(true);
  });

  it("lets an adult through everywhere", () => {
    for (const jurisdiction of JURISDICTIONS) {
      const decision = evaluateAge("1995-06-15", jurisdiction, TODAY);
      expect(decision).toEqual({ valid: true, age: 31, blocked: false, minor: false });
    }
  });

  it("treats an unparseable or absurd date as invalid rather than adult", () => {
    expect(evaluateAge("", "IN", TODAY).valid).toBe(false);
    expect(evaluateAge("1850-01-01", "IN", TODAY).valid).toBe(false);
  });

  it("matches the API's floors exactly", () => {
    // The same numbers the server enforces (`apps/api/src/auth/age-gate.ts`).
    expect(MINIMUM_AGE).toEqual({ IN: 18, EU: 16, OTHER: 0 });
  });
});
