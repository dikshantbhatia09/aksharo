/**
 * Pure commission-rate math (brief §3, 04 §Affiliate):
 *
 *   - months 1-3 of a *monthly* subscription: 40% (4000 bps)
 *   - months 4-12 of a *monthly* subscription: 15% (1500 bps)
 *   - a *yearly* subscription payment: 20% (2000 bps), once ever per referral
 *   - once an affiliate has 10 active paying referrals, its tier becomes
 *     `while_subscribed_30`: every subsequent payment of every referral from
 *     that point earns a flat 30% (3000 bps), overriding the schedule above —
 *     this is a forward-only switch (not retroactive on commissions already
 *     recorded).
 *
 * Kept side-effect free and DB free so the schedule table in the brief's
 * acceptance criteria can be asserted exactly, in minor units, without a
 * database.
 */

export type CommissionInterval = "month" | "year" | "halfyear" | "once";
export type AffiliateTier = "standard" | "while_subscribed_30";

export const RATE_BPS = {
  monthTier1to3: 4000,
  monthTier4to12: 1500,
  yearlyOnce: 2000,
  whileSubscribed30: 3000,
} as const;

export const ACTIVE_REFERRALS_FOR_TIER_UPGRADE = 10;

export interface RateInput {
  readonly tier: AffiliateTier;
  readonly interval: CommissionInterval;
  /** Monthly-interval paid invoices already commissioned for this referral (0-based, before this one). */
  readonly monthlyPaidCountSoFar: number;
  /** Whether the once-only yearly commission has already been paid for this referral. */
  readonly yearlyCommissionPaid: boolean;
}

export interface RateResult {
  /** `null` when this payment earns no commission (e.g. a second yearly payment, standard tier). */
  readonly rateBps: number | null;
  readonly incrementsMonthlyCount: boolean;
  readonly marksYearlyPaid: boolean;
}

/**
 * `halfyear` and `once` (pay-once passes, non-subscription) are not part of
 * the recurring-referral commission schedule (04 §Affiliate only describes
 * monthly and yearly plan payments) and earn nothing — they are Studio-only
 * or one-off SKUs, never what a referred *subscriber* pays month to month.
 */
export function rateForPayment(input: RateInput): RateResult {
  if (input.tier === "while_subscribed_30") {
    return {
      rateBps: RATE_BPS.whileSubscribed30,
      incrementsMonthlyCount: input.interval === "month",
      marksYearlyPaid: input.interval === "year",
    };
  }

  if (input.interval === "month") {
    const monthNumber = input.monthlyPaidCountSoFar + 1; // 1-based month being paid now
    const rateBps = monthNumber <= 3 ? RATE_BPS.monthTier1to3 : RATE_BPS.monthTier4to12;
    return { rateBps, incrementsMonthlyCount: true, marksYearlyPaid: false };
  }

  if (input.interval === "year") {
    if (input.yearlyCommissionPaid) {
      return { rateBps: null, incrementsMonthlyCount: false, marksYearlyPaid: false };
    }
    return { rateBps: RATE_BPS.yearlyOnce, incrementsMonthlyCount: false, marksYearlyPaid: true };
  }

  return { rateBps: null, incrementsMonthlyCount: false, marksYearlyPaid: false };
}

/** Basis-points × minor-unit amount, floored (never overpay a fraction of a paisa). */
export function applyRateBps(amountMinor: number, rateBps: number): number {
  return Math.floor((amountMinor * rateBps) / 10000);
}

export function tierAfterActiveCount(
  activeCount: number,
  currentTier: AffiliateTier,
): AffiliateTier {
  if (currentTier === "while_subscribed_30") return "while_subscribed_30";
  return activeCount >= ACTIVE_REFERRALS_FOR_TIER_UPGRADE ? "while_subscribed_30" : "standard";
}
