import { describe, expect, it } from "vitest";

import { generateReferralCode, isReferralCode, normalizeReferralCode } from "./referral-code.js";

describe("referral codes", () => {
  it("generates a code with no ambiguous characters", () => {
    const code = generateReferralCode();
    expect(code).toMatch(/^AK-[A-Z0-9]{6}$/);
    expect(code).not.toMatch(/[0O1IL]/);
  });

  it("classifies AK- codes as referral codes, others as not", () => {
    expect(isReferralCode("AK-4H7K2M")).toBe(true);
    expect(isReferralCode("ak-4h7k2m")).toBe(true);
    expect(isReferralCode("SOMEAFFCODE")).toBe(false);
    expect(isReferralCode("")).toBe(false);
  });

  it("normalizes a code to uppercase, trimmed", () => {
    expect(normalizeReferralCode(" ak-4h7k2m ")).toBe("AK-4H7K2M");
  });
});
