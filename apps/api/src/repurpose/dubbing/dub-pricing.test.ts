import { describe, expect, it } from "vitest";

import {
  DUB_TENTHS_PER_MINUTE,
  DUB_VENDOR_PAISE_PER_MINUTE,
  billedSeconds,
  dubCostTenths,
  dubVendorPaise,
} from "./dub-pricing.js";

describe("dub pricing (2026-10-04)", () => {
  it("charges 25 credits a minute a language, per clip second", () => {
    expect(DUB_TENTHS_PER_MINUTE).toBe(250);
    expect(dubCostTenths(60_000, 1)).toBe(250);
    expect(dubCostTenths(60_000, 2)).toBe(500);
    // 34 s in two languages: 34 * 2 * 250 / 60 = 283.3 -> 284 tenths.
    expect(dubCostTenths(34_000, 2)).toBe(284);
    // A part of a second is a whole second.
    expect(dubCostTenths(34_001, 1)).toBe(dubCostTenths(35_000, 1));
  });

  it("counts the vendor's ₹40 a minute a language, rounded up", () => {
    expect(DUB_VENDOR_PAISE_PER_MINUTE).toBe(4_000);
    expect(dubVendorPaise(60_000, 1)).toBe(4_000);
    expect(dubVendorPaise(45_000, 3)).toBe(9_000);
    expect(dubVendorPaise(1, 1)).toBe(67);
  });

  it("never bills less than a second, nor a negative language count", () => {
    expect(billedSeconds(0)).toBe(1);
    expect(billedSeconds(Number.NaN)).toBe(1);
    expect(dubCostTenths(30_000, -2)).toBe(0);
  });
});
