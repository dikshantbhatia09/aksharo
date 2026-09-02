import { describe, expect, it } from "vitest";

import { backComputeInclusive, roundMinor } from "./inclusive-tax.js";

describe("backComputeInclusive", () => {
  it("splits an intra-state ₹699 (69900 paise) invoice into CGST 9% + SGST 9%", () => {
    // Rule 35: tax = 69900 × 1800 / 11800 = 10662.71... -> 10663; taxable = 59237.
    const result = backComputeInclusive(69_900, 1800, true);
    expect(result.totalTaxMinor).toBe(10_663);
    expect(result.taxableValueMinor).toBe(59_237);
    expect(result.cgstMinor).toBe(5_331);
    expect(result.sgstMinor).toBe(5_332);
    expect(result.igstMinor).toBe(0);
    expect(result.taxableValueMinor + result.totalTaxMinor).toBe(69_900);
    expect(result.roundOffMinor).toBe(0);
  });

  it("puts the whole tax under IGST for an inter-state supply, same total", () => {
    const result = backComputeInclusive(69_900, 1800, false);
    expect(result.igstMinor).toBe(10_663);
    expect(result.cgstMinor).toBe(0);
    expect(result.sgstMinor).toBe(0);
    expect(result.taxableValueMinor).toBe(59_237);
  });

  it("is zero-rated (rateBps 0) for export/SEZ/RCM — taxable value equals the total", () => {
    const result = backComputeInclusive(190_000, 0, false);
    expect(result).toMatchObject({
      taxableValueMinor: 190_000,
      totalTaxMinor: 0,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 0,
      roundOffMinor: 0,
    });
  });

  it("keeps CGST and SGST within one paisa of each other on an odd total tax amount", () => {
    // Any odd totalTaxMinor forces one half to take the extra paisa.
    const result = backComputeInclusive(101, 1800, true); // totalTax = round(101*1800/11800) = 15 (odd)
    expect(result.totalTaxMinor % 2).toBe(1);
    expect(Math.abs(result.cgstMinor - result.sgstMinor)).toBe(1);
    expect(result.cgstMinor + result.sgstMinor).toBe(result.totalTaxMinor);
  });

  it("always reconciles taxable + tax + roundOff back to the total, across a sweep of amounts", () => {
    for (let total = 0; total <= 2_000; total += 37) {
      for (const intraState of [true, false]) {
        const result = backComputeInclusive(total, 1800, intraState);
        expect(
          result.taxableValueMinor +
            result.cgstMinor +
            result.sgstMinor +
            result.igstMinor +
            result.roundOffMinor,
        ).toBe(total);
      }
    }
  });

  it("rejects a negative or non-integer total", () => {
    expect(() => backComputeInclusive(-1, 1800, true)).toThrow(RangeError);
    expect(() => backComputeInclusive(1.5, 1800, true)).toThrow(RangeError);
  });

  it("computes a USD export invoice (no GST) at its own total", () => {
    // $19.00 = 1900 cents, export supply => rateBps 0.
    const result = backComputeInclusive(1_900, 0, false);
    expect(result.taxableValueMinor).toBe(1_900);
    expect(result.totalTaxMinor).toBe(0);
  });
});

describe("roundMinor", () => {
  it("rounds half away from zero", () => {
    expect(roundMinor(10.5)).toBe(11);
    expect(roundMinor(10.4)).toBe(10);
    expect(roundMinor(-10.5)).toBe(-11);
  });
});
