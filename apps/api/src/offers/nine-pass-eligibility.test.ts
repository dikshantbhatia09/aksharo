import { describe, expect, it } from "vitest";

import { evaluateNinePassEligibility } from "./nine-pass-eligibility.js";

const NOW = new Date("2026-09-02T00:00:00.000Z");

describe("evaluateNinePassEligibility (D04, 04 §Offers, orchestrator addendum)", () => {
  it("eligible: Free, INR, no prior purchase", () => {
    const result = evaluateNinePassEligibility({
      currency: "INR",
      planKey: "free",
      lastPurchaseAt: null,
      now: NOW,
    });
    expect(result).toEqual({ eligible: true, reason: null, nextEligibleAt: null });
  });

  it("ineligible: USD currency, even on Free with no prior purchase", () => {
    const result = evaluateNinePassEligibility({
      currency: "USD",
      planKey: "free",
      lastPurchaseAt: null,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("currency_not_inr");
  });

  it.each(["starter", "creator", "studio", "agency"] as const)(
    "ineligible: on a paid plan (%s), even INR with no prior purchase",
    (planKey) => {
      const result = evaluateNinePassEligibility({
        currency: "INR",
        planKey,
        lastPurchaseAt: null,
        now: NOW,
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("on_paid_plan");
    },
  );

  it("ineligible: purchased 10 days ago (inside the 30-day window)", () => {
    const lastPurchaseAt = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1_000);
    const result = evaluateNinePassEligibility({
      currency: "INR",
      planKey: "free",
      lastPurchaseAt,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("purchased_within_30_days");
    expect(result.nextEligibleAt).toBe(
      new Date(lastPurchaseAt.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    );
  });

  it("ineligible: purchased exactly 29 days 23:59:59 ago (one second short of 30 days)", () => {
    const lastPurchaseAt = new Date(NOW.getTime() - (30 * 24 * 60 * 60 * 1_000 - 1_000));
    const result = evaluateNinePassEligibility({
      currency: "INR",
      planKey: "free",
      lastPurchaseAt,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("purchased_within_30_days");
  });

  it("eligible: purchased exactly 30 days ago (boundary is inclusive of the new window opening)", () => {
    const lastPurchaseAt = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1_000);
    const result = evaluateNinePassEligibility({
      currency: "INR",
      planKey: "free",
      lastPurchaseAt,
      now: NOW,
    });
    expect(result).toEqual({ eligible: true, reason: null, nextEligibleAt: null });
  });

  it("eligible: purchased 31 days ago (outside the window)", () => {
    const lastPurchaseAt = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1_000);
    const result = evaluateNinePassEligibility({
      currency: "INR",
      planKey: "free",
      lastPurchaseAt,
      now: NOW,
    });
    expect(result.eligible).toBe(true);
  });

  it("currency is checked before plan (USD on a paid plan still reports currency, not plan)", () => {
    const result = evaluateNinePassEligibility({
      currency: "USD",
      planKey: "starter",
      lastPurchaseAt: null,
      now: NOW,
    });
    expect(result.reason).toBe("currency_not_inr");
  });

  it("plan is checked before the 30-day window (paid plan with a recent purchase still reports plan)", () => {
    const result = evaluateNinePassEligibility({
      currency: "INR",
      planKey: "creator",
      lastPurchaseAt: new Date(NOW.getTime() - 1_000),
      now: NOW,
    });
    expect(result.reason).toBe("on_paid_plan");
  });
});
