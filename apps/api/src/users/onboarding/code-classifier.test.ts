import { describe, expect, it } from "vitest";

import { classifyOnboardingCode } from "./code-classifier.js";

describe("classifyOnboardingCode", () => {
  it("classifies AK- prefixed codes as referral", () => {
    expect(classifyOnboardingCode("AK-7X3K9M")).toBe("referral");
    expect(classifyOnboardingCode("ak-7x3k9m")).toBe("referral");
    expect(classifyOnboardingCode(" AK-7X3K \t")).toBe("referral");
  });

  it("classifies an 8-character Crockford code as affiliate", () => {
    expect(classifyOnboardingCode("7H3K9MPQ")).toBe("affiliate");
    expect(classifyOnboardingCode("7h3k9mpq")).toBe("affiliate");
  });

  it("rejects ambiguous glyphs (I, L, O, U) an affiliate code never contains", () => {
    expect(classifyOnboardingCode("7H3K9MPI")).toBe("invalid");
    expect(classifyOnboardingCode("7H3K9MPU")).toBe("invalid");
  });

  it("classifies blank or garbage input as invalid", () => {
    expect(classifyOnboardingCode("")).toBe("invalid");
    expect(classifyOnboardingCode("   ")).toBe("invalid");
    expect(classifyOnboardingCode("not a code!!")).toBe("invalid");
  });
});
