import { describe, expect, it } from "vitest";

import { GST_STATES, gstState, isGstStateCode } from "./gst-state-codes.js";
import { GSTIN_PATTERN, gstinCheckDigit, validateGstin } from "./gstin.js";

/**
 * The three GSTINs below are published numbers whose check digit is arithmetic,
 * not a guess: each one is verified against the base-36 algorithm in
 * `gstinCheckDigit`, which is itself the published GSTN construction. They are
 * business registrations, not personal data.
 */
const MAHARASHTRA = "27AAPFU0939F1ZV";
const KARNATAKA = "29AAGCB7383J1Z4";
const UTTAR_PRADESH = "09AAACH7409R1ZZ";

describe("GST State codes", () => {
  it("holds the 36 live jurisdictions: 28 States and 8 Union Territories", () => {
    expect(GST_STATES).toHaveLength(36);
    expect(GST_STATES.filter((state) => state.type === "state")).toHaveLength(28);
    expect(GST_STATES.filter((state) => state.type === "union_territory")).toHaveLength(8);
  });

  it("uses two-digit codes and never repeats one", () => {
    const codes = GST_STATES.map((state) => state.code);
    expect(codes.every((code) => /^[0-9]{2}$/.test(code))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("omits the codes a customer cannot be in today", () => {
    // 25 merged into 26 in 2020; 28 was replaced by 37 after the bifurcation;
    // 97 and 99 are the portal's own administrative buckets.
    for (const retired of ["25", "28", "97", "99", "00"]) {
      expect(isGstStateCode(retired)).toBe(false);
    }
  });

  it("names the States the well-known codes belong to", () => {
    expect(gstState("27")?.name).toBe("Maharashtra");
    expect(gstState("29")?.name).toBe("Karnataka");
    expect(gstState("37")?.name).toBe("Andhra Pradesh");
    expect(gstState("38")?.name).toBe("Ladakh");
  });
});

describe("gstinCheckDigit", () => {
  it("reproduces the check digit of a real GSTIN", () => {
    for (const gstin of [MAHARASHTRA, KARNATAKA, UTTAR_PRADESH]) {
      expect(gstinCheckDigit(gstin.slice(0, 14))).toBe(gstin[14]);
    }
  });

  it("refuses anything that is not 14 characters of the alphabet", () => {
    expect(gstinCheckDigit("27AAPFU0939F1")).toBeUndefined();
    expect(gstinCheckDigit("27AAPFU0939F1ZV")).toBeUndefined();
    expect(gstinCheckDigit("27AAPFU0939F1-")).toBeUndefined();
  });

  it("changes when any single character changes — the point of a check digit", () => {
    const base = MAHARASHTRA.slice(0, 14);
    const mutated = `${base.slice(0, 5)}${base[5] === "U" ? "V" : "U"}${base.slice(6)}`;
    expect(gstinCheckDigit(mutated)).not.toBe(gstinCheckDigit(base));
  });
});

describe("validateGstin", () => {
  it("accepts a well-formed number and reports its State and PAN", () => {
    const verdict = validateGstin(MAHARASHTRA);
    expect(verdict).toEqual({
      ok: true,
      gstin: MAHARASHTRA,
      stateCode: "27",
      pan: "AAPFU0939F",
    });
  });

  it("normalises case and stray whitespace before judging", () => {
    expect(validateGstin(` ${MAHARASHTRA.toLowerCase()} `)).toMatchObject({ ok: true });
    expect(validateGstin("27 AAPFU0939F 1ZV")).toMatchObject({ ok: true });
  });

  it("rejects a number of the wrong shape", () => {
    for (const bad of ["", "27AAPFU0939F1Z", "AA27PFU0939F1ZV", "27AAPFU0939F1AV"]) {
      expect(validateGstin(bad)).toMatchObject({ ok: false, problem: "malformed" });
    }
  });

  it("rejects a transposition that keeps the shape", () => {
    // Swap two characters of a valid number: still 15 characters, still matches
    // the pattern, and only the check digit knows it is wrong.
    const transposed = `${KARNATAKA.slice(0, 4)}${KARNATAKA[5] ?? ""}${KARNATAKA[4] ?? ""}${KARNATAKA.slice(6)}`;
    expect(GSTIN_PATTERN.test(transposed)).toBe(true);
    expect(validateGstin(transposed)).toMatchObject({ ok: false, problem: "checksum_mismatch" });
  });

  it("rejects a number whose State code is retired", () => {
    // 25 (Daman and Diu) merged into 26; build a number that is otherwise sound.
    const stem = `25${MAHARASHTRA.slice(2, 14)}`;
    const gstin = `${stem}${gstinCheckDigit(stem) ?? ""}`;
    expect(validateGstin(gstin)).toMatchObject({
      ok: false,
      problem: "unknown_state_code",
      stateCode: "25",
    });
  });

  it("rejects a number whose State disagrees with the billing State", () => {
    expect(validateGstin(MAHARASHTRA, "29")).toEqual({
      ok: false,
      problem: "state_mismatch",
      stateCode: "27",
    });
  });

  it("accepts a number whose State agrees with the billing State", () => {
    expect(validateGstin(KARNATAKA, "29")).toMatchObject({ ok: true, stateCode: "29" });
  });
});
