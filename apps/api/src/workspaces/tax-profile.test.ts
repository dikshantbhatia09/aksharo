import { describe, expect, it } from "vitest";

import { currencyForCountry, regionForCountry, validateTaxProfile } from "./tax-profile.js";

const MAHARASHTRA_GSTIN = "27AAPFU0939F1ZV";
const KARNATAKA_GSTIN = "29AAGCB7383J1Z4";

describe("currencyForCountry", () => {
  it("is INR for India and USD for everywhere else (04 §Tax)", () => {
    expect(currencyForCountry("IN")).toBe("INR");
    for (const country of ["US", "DE", "GB", "AE", "SG"]) {
      expect(currencyForCountry(country)).toBe("USD");
    }
  });
});

describe("regionForCountry", () => {
  it("pins India to `in`, the EU/EEA to `eu` and the rest to `us` (T24)", () => {
    expect(regionForCountry("IN")).toBe("in");
    expect(regionForCountry("DE")).toBe("eu");
    expect(regionForCountry("NO")).toBe("eu");
    expect(regionForCountry("US")).toBe("us");
    expect(regionForCountry("AU")).toBe("us");
  });
});

describe("validateTaxProfile — India", () => {
  it("derives INR and the `in` region from the country alone", () => {
    const result = validateTaxProfile({ billingCountry: "IN", billingStateCode: "27" });
    expect(result).toMatchObject({
      ok: true,
      profile: { currency: "INR", region: "in", billingStateCode: "27", gstin: null },
    });
  });

  it("requires a State code (Circular 242/36/2024-GST, D41)", () => {
    expect(validateTaxProfile({ billingCountry: "IN" })).toMatchObject({
      ok: false,
      problem: "state_required",
    });
  });

  it("rejects a State code that is not one of the 36", () => {
    expect(validateTaxProfile({ billingCountry: "IN", billingStateCode: "99" })).toMatchObject({
      ok: false,
      problem: "state_invalid",
      details: { billingStateCode: "99" },
    });
  });

  it("accepts a GSTIN whose State matches, and normalises it", () => {
    const result = validateTaxProfile({
      billingCountry: "in",
      billingStateCode: "27",
      gstin: MAHARASHTRA_GSTIN.toLowerCase(),
      legalName: "  Umbrella Films LLP  ",
    });
    expect(result).toMatchObject({
      ok: true,
      profile: {
        billingCountry: "IN",
        gstin: MAHARASHTRA_GSTIN,
        legalName: "Umbrella Films LLP",
      },
    });
  });

  it("rejects a GSTIN whose State disagrees with the billing State", () => {
    expect(
      validateTaxProfile({
        billingCountry: "IN",
        billingStateCode: "27",
        gstin: KARNATAKA_GSTIN,
      }),
    ).toMatchObject({
      ok: false,
      problem: "gstin_state_mismatch",
      details: { billingStateCode: "27", gstinStateCode: "29" },
    });
  });

  it("rejects a GSTIN whose check digit is wrong", () => {
    const wrongDigit = `${MAHARASHTRA_GSTIN.slice(0, 14)}X`;
    expect(
      validateTaxProfile({ billingCountry: "IN", billingStateCode: "27", gstin: wrongDigit }),
    ).toMatchObject({ ok: false, problem: "gstin_checksum_mismatch" });
  });

  it("rejects a GSTIN of the wrong shape", () => {
    expect(
      validateTaxProfile({ billingCountry: "IN", billingStateCode: "27", gstin: "not-a-gstin" }),
    ).toMatchObject({ ok: false, problem: "gstin_malformed" });
  });
});

describe("validateTaxProfile — outside India", () => {
  it("needs no State code and derives USD", () => {
    expect(validateTaxProfile({ billingCountry: "US" })).toMatchObject({
      ok: true,
      profile: { currency: "USD", region: "us", billingStateCode: null, gstin: null },
    });
  });

  it("refuses a State code rather than silently dropping it", () => {
    // A field the customer filled in and the system ignored is how an invoice ends
    // up disagreeing with the address on record.
    expect(validateTaxProfile({ billingCountry: "US", billingStateCode: "27" })).toMatchObject({
      ok: false,
      problem: "state_not_applicable",
    });
  });

  it("refuses a GSTIN rather than silently dropping it", () => {
    expect(validateTaxProfile({ billingCountry: "DE", gstin: MAHARASHTRA_GSTIN })).toMatchObject({
      ok: false,
      problem: "gstin_not_applicable",
    });
  });

  it("treats an empty string as absent", () => {
    expect(
      validateTaxProfile({ billingCountry: "GB", billingStateCode: "", gstin: "", legalName: "" }),
    ).toMatchObject({ ok: true, profile: { legalName: null } });
  });
});

describe("validateTaxProfile — the country itself", () => {
  it("rejects anything that is not two letters", () => {
    for (const country of ["", "I", "IND", "1N", "  "]) {
      expect(validateTaxProfile({ billingCountry: country })).toMatchObject({
        ok: false,
        problem: "country_invalid",
      });
    }
  });

  it("normalises case and surrounding space", () => {
    expect(validateTaxProfile({ billingCountry: " de " })).toMatchObject({
      ok: true,
      profile: { billingCountry: "DE", region: "eu" },
    });
  });
});
