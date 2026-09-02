import { describe, expect, it } from "vitest";

import { generateLicenseKey, normaliseLicenseKey } from "./license-key.util.js";

describe("generateLicenseKey", () => {
  it("produces AK-XXXX-XXXX-XXXX from an unambiguous alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const key = generateLicenseKey();
      expect(key).toMatch(
        /^AK-[CDFGHJKMNPQRTVWXZ23469]{4}-[CDFGHJKMNPQRTVWXZ23469]{4}-[CDFGHJKMNPQRTVWXZ23469]{4}$/,
      );
    }
  });

  it("never repeats across a large sample (CSPRNG, not a fixed seed)", () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateLicenseKey()));
    expect(keys.size).toBe(500);
  });
});

describe("normaliseLicenseKey", () => {
  it("upper-cases and trims what a person typed", () => {
    expect(normaliseLicenseKey("  ak-cdfg-hjkm-npqr  ")).toBe("AK-CDFG-HJKM-NPQR");
  });
});
