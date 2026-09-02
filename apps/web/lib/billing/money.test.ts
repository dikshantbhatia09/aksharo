import { describe, expect, it } from "vitest";

import {
  estimateSeatedTotalMinor,
  exceedsUpiAutopayCap,
  formatDate,
  formatDateTime,
  formatMoney,
  gstBreakup,
  monthlyEquivalentMinor,
  priceForInterval,
  UPI_AUTOPAY_CAP_MINOR,
} from "./money";

describe("formatMoney", () => {
  it("formats whole-rupee INR without decimals", () => {
    expect(formatMoney(69_900, "INR")).toBe("₹699");
  });

  it("formats USD with cents when the amount is not a whole dollar", () => {
    expect(formatMoney(1_950, "USD")).toBe("$19.50");
  });

  it("formats zero as free", () => {
    expect(formatMoney(0, "INR")).toBe("₹0");
  });
});

describe("monthlyEquivalentMinor", () => {
  it("divides the yearly price by 12 and rounds — Creator's '2 months free' figure", () => {
    // 04 §Plans: Creator yearly per-month equivalent is ₹582.
    expect(monthlyEquivalentMinor({ month: 69_900, year: 698_400 })).toBe(58_200);
  });
});

describe("exceedsUpiAutopayCap", () => {
  it("is false at exactly the ₹15,000 cap", () => {
    expect(exceedsUpiAutopayCap(UPI_AUTOPAY_CAP_MINOR)).toBe(false);
  });

  it("is true one paisa over the cap", () => {
    expect(exceedsUpiAutopayCap(UPI_AUTOPAY_CAP_MINOR + 1)).toBe(true);
  });

  it("is true for Studio yearly (₹19,992), which is why the halfyear split exists", () => {
    expect(exceedsUpiAutopayCap(1_999_200)).toBe(true);
  });

  it("is false for Creator yearly (₹6,984)", () => {
    expect(exceedsUpiAutopayCap(698_400)).toBe(false);
  });
});

describe("priceForInterval", () => {
  it("returns undefined for halfyear when the plan has none", () => {
    expect(priceForInterval({ month: 29_900, year: 298_800 }, "halfyear")).toBeUndefined();
  });

  it("returns the halfyear price when present", () => {
    expect(
      priceForInterval({ month: 199_900, year: 1_999_200, halfyear: 999_600 }, "halfyear"),
    ).toBe(999_600);
  });
});

describe("formatDate", () => {
  it("renders an unambiguous day-month-year", () => {
    expect(formatDate("2027-05-03T00:00:00.000Z")).toBe("3 May 2027");
  });

  it("falls back to an em dash for null, undefined or an invalid string", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
  });
});

describe("estimateSeatedTotalMinor", () => {
  it("charges nothing extra for exactly the included seat count", () => {
    // Agency: base ₹1,199 covers seat 1.
    expect(estimateSeatedTotalMinor(119_900, 119_900, 1, "month")).toBe(119_900);
  });

  it("adds the per-seat price for each seat above the included count", () => {
    expect(estimateSeatedTotalMinor(119_900, 119_900, 3, "month")).toBe(119_900 + 2 * 119_900);
  });

  it("multiplies the extra-seat price by 10 months for a yearly interval", () => {
    expect(estimateSeatedTotalMinor(119_900, 119_900, 2, "year")).toBe(119_900 + 119_900 * 10);
  });

  it("never charges for fewer seats than included", () => {
    expect(estimateSeatedTotalMinor(119_900, 119_900, 0, "month")).toBe(119_900);
  });
});

describe("gstBreakup", () => {
  it("splits Creator's ₹699 into taxable value and 18% GST that sum back to the total", () => {
    const result = gstBreakup(69_900);
    expect(result.taxableValueMinor + result.gstMinor).toBe(69_900);
    // ₹699 / 1.18 ≈ ₹592.37 → ₹592 taxable, ₹107 GST.
    expect(result.taxableValueMinor).toBe(59_237);
    expect(result.gstMinor).toBe(10_663);
  });

  it("is zero GST on a zero total", () => {
    expect(gstBreakup(0)).toEqual({ taxableValueMinor: 0, gstMinor: 0, totalMinor: 0 });
  });
});

describe("formatDateTime", () => {
  it("includes the hour a person reads", () => {
    expect(formatDateTime("2027-05-03T18:00:00.000Z")).toBe("3 May 2027, 6:00 pm");
  });

  it("falls back to an em dash for a missing value", () => {
    expect(formatDateTime(null)).toBe("—");
  });
});
