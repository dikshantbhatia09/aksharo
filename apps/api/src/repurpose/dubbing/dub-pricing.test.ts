import { describe, expect, it } from "vitest";

import {
  DUB_TENTHS_PER_MINUTE,
  DUB_VENDOR_PAISE_PER_MINUTE,
  billedSeconds,
  dubCostTenths,
  dubVendorPaise,
} from "./dub-pricing.js";

describe("dub pricing (2026-10-04)", () => {
  it("charges 50 credits a minute a language, per clip second", () => {
    expect(DUB_TENTHS_PER_MINUTE).toBe(500);
    expect(dubCostTenths(60_000, 1)).toBe(500);
    expect(dubCostTenths(60_000, 2)).toBe(1_000);
    // 34 s in two languages: 34 * 2 * 500 / 60 = 566.7 -> 567 tenths.
    expect(dubCostTenths(34_000, 2)).toBe(567);
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

describe("dub pricing covers the vendor on every plan (2026-09-30)", () => {
  // What one credit costs a person on each plan, in paise: price / credits.
  const PAISE_PER_CREDIT = {
    starter: 29_900 / 150,
    creator: 69_900 / 500,
    agency: 119_900 / 900,
    studio: 199_900 / 1_800,
  };

  it("charges more than the vendor's Rs 40 a minute, even on the plan with the cheapest credits", () => {
    for (const [plan, paise] of Object.entries(PAISE_PER_CREDIT)) {
      const chargedPaise = (DUB_TENTHS_PER_MINUTE / 10) * paise;
      expect(chargedPaise, plan).toBeGreaterThan(DUB_VENDOR_PAISE_PER_MINUTE * 1.25);
    }
  });
});
