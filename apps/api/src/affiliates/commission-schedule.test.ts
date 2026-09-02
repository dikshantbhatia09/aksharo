import { describe, expect, it } from "vitest";

import {
  ACTIVE_REFERRALS_FOR_TIER_UPGRADE,
  applyRateBps,
  RATE_BPS,
  rateForPayment,
  tierAfterActiveCount,
} from "./commission-schedule.js";

describe("rateForPayment — the schedule table (brief §3)", () => {
  it("months 1-3 of a monthly subscription earn 40%", () => {
    for (let month = 1; month <= 3; month++) {
      const result = rateForPayment({
        tier: "standard",
        interval: "month",
        monthlyPaidCountSoFar: month - 1,
        yearlyCommissionPaid: false,
      });
      expect(result.rateBps).toBe(RATE_BPS.monthTier1to3);
      expect(result.incrementsMonthlyCount).toBe(true);
    }
  });

  it("months 4-12 of a monthly subscription earn 15%", () => {
    for (let month = 4; month <= 12; month++) {
      const result = rateForPayment({
        tier: "standard",
        interval: "month",
        monthlyPaidCountSoFar: month - 1,
        yearlyCommissionPaid: false,
      });
      expect(result.rateBps).toBe(RATE_BPS.monthTier4to12);
    }
  });

  it("a yearly payment earns 20% once, and nothing on a second yearly payment", () => {
    const first = rateForPayment({
      tier: "standard",
      interval: "year",
      monthlyPaidCountSoFar: 0,
      yearlyCommissionPaid: false,
    });
    expect(first.rateBps).toBe(RATE_BPS.yearlyOnce);
    expect(first.marksYearlyPaid).toBe(true);

    const second = rateForPayment({
      tier: "standard",
      interval: "year",
      monthlyPaidCountSoFar: 0,
      yearlyCommissionPaid: true,
    });
    expect(second.rateBps).toBeNull();
  });

  it("while_subscribed_30 pays a flat 30% on every payment, monthly or yearly, ignoring the schedule", () => {
    const month1 = rateForPayment({
      tier: "while_subscribed_30",
      interval: "month",
      monthlyPaidCountSoFar: 0,
      yearlyCommissionPaid: false,
    });
    expect(month1.rateBps).toBe(RATE_BPS.whileSubscribed30);

    const month20 = rateForPayment({
      tier: "while_subscribed_30",
      interval: "month",
      monthlyPaidCountSoFar: 19,
      yearlyCommissionPaid: false,
    });
    expect(month20.rateBps).toBe(RATE_BPS.whileSubscribed30);

    const yearlyAgain = rateForPayment({
      tier: "while_subscribed_30",
      interval: "year",
      monthlyPaidCountSoFar: 0,
      yearlyCommissionPaid: true, // already paid once, but tier overrides the once-only rule
    });
    expect(yearlyAgain.rateBps).toBe(RATE_BPS.whileSubscribed30);
  });

  it("halfyear and once intervals earn nothing", () => {
    expect(
      rateForPayment({
        tier: "standard",
        interval: "halfyear",
        monthlyPaidCountSoFar: 0,
        yearlyCommissionPaid: false,
      }).rateBps,
    ).toBeNull();
    expect(
      rateForPayment({
        tier: "standard",
        interval: "once",
        monthlyPaidCountSoFar: 0,
        yearlyCommissionPaid: false,
      }).rateBps,
    ).toBeNull();
  });
});

describe("applyRateBps — exact minor-unit arithmetic", () => {
  it("floors rather than rounds", () => {
    expect(applyRateBps(699, 4000)).toBe(279); // 279.6 -> 279
    expect(applyRateBps(69900, 4000)).toBe(27960);
    expect(applyRateBps(69900, 1500)).toBe(10485);
    expect(applyRateBps(69900, 2000)).toBe(13980);
    expect(applyRateBps(69900, 3000)).toBe(20970);
  });
});

describe("tierAfterActiveCount", () => {
  it("upgrades exactly at the 10th active referral, never before", () => {
    expect(tierAfterActiveCount(ACTIVE_REFERRALS_FOR_TIER_UPGRADE - 1, "standard")).toBe(
      "standard",
    );
    expect(tierAfterActiveCount(ACTIVE_REFERRALS_FOR_TIER_UPGRADE, "standard")).toBe(
      "while_subscribed_30",
    );
  });

  it("never downgrades once upgraded", () => {
    expect(tierAfterActiveCount(0, "while_subscribed_30")).toBe("while_subscribed_30");
  });
});
