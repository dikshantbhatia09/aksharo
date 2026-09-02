import { describe, expect, it } from "vitest";

import { GST_STATES, gstinCheckDigit, gstState, isGstStateCode, validateGstin } from "./gst";

/** Published GSTINs whose check digit is arithmetic, mirrored from
 * `apps/api/src/workspaces/gstin.test.ts` (business registrations, not personal data). */
const MAHARASHTRA = "27AAPFU0939F1ZV";
const KARNATAKA = "29AAGCB7383J1Z4";

describe("GST_STATES", () => {
  it("holds the 36 live jurisdictions: 28 States and 8 Union Territories", () => {
    expect(GST_STATES).toHaveLength(36);
    expect(GST_STATES.filter((state) => state.type === "state")).toHaveLength(28);
    expect(GST_STATES.filter((state) => state.type === "union_territory")).toHaveLength(8);
  });

  it("omits the codes a customer cannot be in today", () => {
    for (const retired of ["25", "28", "97", "99", "00"]) {
      expect(isGstStateCode(retired)).toBe(false);
    }
  });

  it("names the well-known codes", () => {
    expect(gstState("27")?.name).toBe("Maharashtra");
    expect(gstState("29")?.name).toBe("Karnataka");
  });
});

describe("gstinCheckDigit", () => {
  it("reproduces the check digit of a real GSTIN", () => {
    expect(gstinCheckDigit(MAHARASHTRA.slice(0, 14))).toBe(MAHARASHTRA[14]);
    expect(gstinCheckDigit(KARNATAKA.slice(0, 14))).toBe(KARNATAKA[14]);
  });

  it("refuses anything that is not 14 characters of the alphabet", () => {
    expect(gstinCheckDigit("27AAPFU0939F1")).toBeUndefined();
    expect(gstinCheckDigit(`${MAHARASHTRA}X`)).toBeUndefined();
  });
});

describe("validateGstin", () => {
  it("accepts a valid GSTIN and reports its State", () => {
    const result = validateGstin(MAHARASHTRA);
    expect(result).toEqual({ ok: true, gstin: MAHARASHTRA, stateCode: "27" });
  });

  it("is case- and whitespace-insensitive", () => {
    const result = validateGstin(` ${MAHARASHTRA.toLowerCase()} `);
    expect(result.ok).toBe(true);
  });

  it("rejects the wrong shape", () => {
    expect(validateGstin("not-a-gstin")).toEqual({ ok: false, problem: "malformed" });
  });

  it("rejects a transposed character (checksum mismatch)", () => {
    const mutated = `${MAHARASHTRA.slice(0, 5)}X${MAHARASHTRA.slice(6)}`;
    expect(validateGstin(mutated).ok).toBe(false);
  });

  it("rejects a GSTIN whose State disagrees with the billing State", () => {
    const result = validateGstin(MAHARASHTRA, "29");
    expect(result).toEqual({ ok: false, problem: "state_mismatch" });
  });

  it("accepts a GSTIN whose State agrees with the billing State", () => {
    expect(validateGstin(KARNATAKA, "29").ok).toBe(true);
  });
});
