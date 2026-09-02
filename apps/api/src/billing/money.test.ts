import { describe, expect, it } from "vitest";

import {
  decideMandate,
  hasHalfyearPrice,
  quotePrice,
  seatsIncluded,
  type PlanForPricing,
} from "./money.js";

/** Prices lifted straight from `prisma/seed-data.ts` (04 §Plans). */
const CREATOR: PlanForPricing = {
  key: "creator",
  active: true,
  prices: { INR: { month: 69_900, year: 698_400 }, USD: { month: 1_900, year: 18_960 } },
  seatPrice: null,
  entitlements: { seatsIncluded: 0 },
};

const STUDIO: PlanForPricing = {
  key: "studio",
  active: true,
  prices: {
    INR: { month: 199_900, year: 1_999_200, halfyear: 999_600 },
    USD: { month: 4_900, year: 49_200 },
  },
  seatPrice: { INR: 39_900, USD: 700 },
  entitlements: { seatsIncluded: 3 },
};

const AGENCY: PlanForPricing = {
  key: "agency",
  active: true,
  prices: { INR: { month: 119_900, year: 1_198_800 }, USD: { month: 2_900, year: 28_800 } },
  seatPrice: { INR: 119_900, USD: 2_900 },
  entitlements: { seatsIncluded: 1 },
};

const STARTER: PlanForPricing = {
  key: "starter",
  active: true,
  prices: { INR: { month: 29_900, year: 298_800 }, USD: { month: 800, year: 8_040 } },
  seatPrice: null,
  entitlements: { seatsIncluded: 0 },
};

describe("quotePrice", () => {
  it("Creator monthly INR is ₹699 with no seats to add", () => {
    const result = quotePrice({ plan: CREATOR, currency: "INR", interval: "month" });
    expect(result).toEqual({
      ok: true,
      quote: {
        listPriceMinor: 69_900,
        baseMinor: 69_900,
        seats: 1,
        seatsIncluded: 0,
        extraSeats: 0,
        extraSeatMinor: 0,
      },
    });
  });

  it("Studio yearly INR is the full ₹19,992 list price", () => {
    const result = quotePrice({ plan: STUDIO, currency: "INR", interval: "year" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quote.listPriceMinor).toBe(1_999_200);
  });

  it("Studio has a halfyear price at ₹9,996 (D05: two half-yearly UPI debits)", () => {
    const result = quotePrice({ plan: STUDIO, currency: "INR", interval: "halfyear" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quote.listPriceMinor).toBe(999_600);
  });

  it("Creator has no halfyear price (only Studio/INR does)", () => {
    const result = quotePrice({ plan: CREATOR, currency: "INR", interval: "halfyear" });
    expect(result).toEqual({ ok: false, reason: "interval_unavailable" });
  });

  it("`once` is Starter/Creator only, at the monthly price", () => {
    const creatorOnce = quotePrice({ plan: CREATOR, currency: "INR", interval: "once" });
    expect(creatorOnce.ok).toBe(true);
    if (creatorOnce.ok) expect(creatorOnce.quote.listPriceMinor).toBe(69_900);

    const studioOnce = quotePrice({ plan: STUDIO, currency: "INR", interval: "once" });
    expect(studioOnce).toEqual({ ok: false, reason: "interval_unavailable" });
  });

  it("an inactive plan is refused regardless of interval", () => {
    const result = quotePrice({
      plan: { ...CREATOR, active: false },
      currency: "INR",
      interval: "month",
    });
    expect(result).toEqual({ ok: false, reason: "plan_inactive" });
  });

  it("Agency seats: each additional seat beyond the 1 included costs the full seat price", () => {
    const result = quotePrice({ plan: AGENCY, currency: "INR", interval: "month", seats: 4 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // base (1 seat) + 3 extra seats at ₹1,199 each
      expect(result.quote).toEqual({
        listPriceMinor: 119_900 + 3 * 119_900,
        baseMinor: 119_900,
        seats: 4,
        seatsIncluded: 1,
        extraSeats: 3,
        extraSeatMinor: 3 * 119_900,
      });
    }
  });

  it("Studio seats: the first 3 are included, extra seats are ₹399/month", () => {
    const withinIncluded = quotePrice({
      plan: STUDIO,
      currency: "INR",
      interval: "month",
      seats: 3,
    });
    expect(withinIncluded.ok).toBe(true);
    if (withinIncluded.ok) expect(withinIncluded.quote.listPriceMinor).toBe(199_900);

    const overIncluded = quotePrice({ plan: STUDIO, currency: "INR", interval: "month", seats: 5 });
    expect(overIncluded.ok).toBe(true);
    if (overIncluded.ok) expect(overIncluded.quote.listPriceMinor).toBe(199_900 + 2 * 39_900);
  });

  it("seat price for a yearly interval is x10 the monthly seat price (documented assumption)", () => {
    const result = quotePrice({ plan: STUDIO, currency: "INR", interval: "year", seats: 4 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quote.extraSeatMinor).toBe(1 * 39_900 * 10);
  });

  it("USD prices are read from the USD branch", () => {
    const result = quotePrice({ plan: CREATOR, currency: "USD", interval: "month" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quote.listPriceMinor).toBe(1_900);
  });
});

describe("hasHalfyearPrice", () => {
  it("is true for Studio/INR and false everywhere else in the seed", () => {
    expect(hasHalfyearPrice(STUDIO, "INR")).toBe(true);
    expect(hasHalfyearPrice(STUDIO, "USD")).toBe(false);
    expect(hasHalfyearPrice(CREATOR, "INR")).toBe(false);
  });
});

describe("seatsIncluded", () => {
  it("reads a number and defaults to 0 for anything else", () => {
    expect(seatsIncluded({ seatsIncluded: 3 })).toBe(3);
    expect(seatsIncluded({})).toBe(0);
    expect(seatsIncluded(null)).toBe(0);
    expect(seatsIncluded("nope")).toBe(0);
  });
});

describe("decideMandate — the ₹15,000 UPI Autopay rule (D05, D40)", () => {
  it("Creator monthly (₹699) fits comfortably under UPI Autopay", () => {
    expect(decideMandate({ currency: "INR", capMinor: 69_900 })).toEqual({
      ok: true,
      kind: "recurring",
      mandate: { method: "upi_autopay", afaRequiredPerDebit: false },
    });
  });

  it("Creator yearly (₹6,984) fits a single UPI mandate", () => {
    expect(decideMandate({ currency: "INR", capMinor: 698_400 })).toEqual({
      ok: true,
      kind: "recurring",
      mandate: { method: "upi_autopay", afaRequiredPerDebit: false },
    });
  });

  it("exactly ₹15,000 is allowed (the cap is inclusive)", () => {
    expect(decideMandate({ currency: "INR", capMinor: 1_500_000 })).toMatchObject({ ok: true });
  });

  it("₹15,000.01 (1,500,001 paise) is refused for UPI Autopay", () => {
    expect(decideMandate({ currency: "INR", capMinor: 1_500_001 })).toEqual({
      ok: false,
      reason: "cap_exceeded",
    });
  });

  it("Studio yearly (₹19,992) is refused on UPI Autopay by default", () => {
    expect(decideMandate({ currency: "INR", capMinor: 1_999_200 })).toEqual({
      ok: false,
      reason: "cap_exceeded",
    });
  });

  it("Studio yearly on eNACH is a recurring mandate with AFA required every debit", () => {
    expect(
      decideMandate({ currency: "INR", capMinor: 1_999_200, requestedMethod: "enach" }),
    ).toEqual({
      ok: true,
      kind: "recurring",
      mandate: { method: "enach", afaRequiredPerDebit: true },
    });
  });

  it("Studio yearly on card above the cap is a one-time charge, not a mandate", () => {
    expect(
      decideMandate({ currency: "INR", capMinor: 1_999_200, requestedMethod: "card" }),
    ).toEqual({
      ok: true,
      kind: "one_time",
      method: "card",
    });
  });

  it("card under the cap is a normal recurring mandate", () => {
    expect(decideMandate({ currency: "INR", capMinor: 69_900, requestedMethod: "card" })).toEqual({
      ok: true,
      kind: "recurring",
      mandate: { method: "card", afaRequiredPerDebit: false },
    });
  });

  it("the halfyear split (₹9,996) fits back under the cap", () => {
    expect(decideMandate({ currency: "INR", capMinor: 999_600 })).toMatchObject({
      ok: true,
      mandate: { method: "upi_autopay" },
    });
  });

  it("USD always resolves to a recurring card mandate, no UPI cap applies", () => {
    expect(decideMandate({ currency: "USD", capMinor: 100_000_000 })).toEqual({
      ok: true,
      kind: "recurring",
      mandate: { method: "card", afaRequiredPerDebit: false },
    });
  });
});

// Table test across every plan/interval combination named in the acceptance
// criteria (Studio yearly alternatives, Agency seats, coupons out of scope).
describe("checkout math — table", () => {
  const cases: readonly {
    readonly name: string;
    readonly plan: PlanForPricing;
    readonly currency: "INR" | "USD";
    readonly interval: "month" | "year" | "halfyear" | "once";
    readonly seats?: number;
    readonly expectMinor?: number;
    readonly expectUnavailable?: boolean;
  }[] = [
    {
      name: "Free-tier Starter monthly INR",
      plan: STARTER,
      currency: "INR",
      interval: "month",
      expectMinor: 29_900,
    },
    {
      name: "Creator monthly USD",
      plan: CREATOR,
      currency: "USD",
      interval: "month",
      expectMinor: 1_900,
    },
    {
      name: "Studio yearly INR (mandate-cap trigger)",
      plan: STUDIO,
      currency: "INR",
      interval: "year",
      expectMinor: 1_999_200,
    },
    {
      name: "Studio halfyear INR (D05 split)",
      plan: STUDIO,
      currency: "INR",
      interval: "halfyear",
      expectMinor: 999_600,
    },
    {
      name: "Studio halfyear USD (unavailable)",
      plan: STUDIO,
      currency: "USD",
      interval: "halfyear",
      expectUnavailable: true,
    },
    {
      name: "Agency monthly, 5 seats",
      plan: AGENCY,
      currency: "INR",
      interval: "month",
      seats: 5,
      expectMinor: 119_900 * 5,
    },
    {
      name: "Starter pay-once",
      plan: STARTER,
      currency: "INR",
      interval: "once",
      expectMinor: 29_900,
    },
    {
      name: "Agency pay-once (unavailable)",
      plan: AGENCY,
      currency: "INR",
      interval: "once",
      expectUnavailable: true,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = quotePrice({
        plan: testCase.plan,
        currency: testCase.currency,
        interval: testCase.interval,
        ...(testCase.seats === undefined ? {} : { seats: testCase.seats }),
      });
      if (testCase.expectUnavailable === true) {
        expect(result.ok).toBe(false);
      } else {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.quote.listPriceMinor).toBe(testCase.expectMinor);
      }
    });
  }
});
