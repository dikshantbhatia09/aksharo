/**
 * Pure eligibility rules for the ₹9 clean-export pass (D04, `04 §Offers`,
 * orchestrator addendum after A21): "INR-only, browser-only, once per account
 * per 30 days, never on a paid plan."
 *
 * Pure and synchronous on purpose, exactly like `exports/decision.ts` — every
 * input is a value the caller (`NinePassEligibilityService`) already resolved
 * from Prisma, so the eligibility table can be tested exhaustively without a
 * database. "Browser-only" is not decided here: that half of the rule already
 * lives in `exports/decision.ts#chooseWatermark` (a ₹9 pass only ever clears a
 * watermark on the browser path); this module governs whether a *new* pass may
 * be bought at all.
 */
import { NINE_PASS_ELIGIBILITY_WINDOW_DAYS } from "./offers.constants.js";

import type { $Enums } from "@prisma/client";

export interface NinePassEligibilityInput {
  readonly currency: $Enums.Currency;
  /** The workspace's current live plan; `free` with no subscription. */
  readonly planKey: $Enums.PlanKey;
  /** `createdAt` of the workspace's most recent `first_export` pass purchase, if any. */
  readonly lastPurchaseAt: Date | null;
  readonly now: Date;
}

export type NinePassIneligibleReason =
  "currency_not_inr" | "on_paid_plan" | "purchased_within_30_days";

export interface NinePassEligibility {
  readonly eligible: boolean;
  readonly reason: NinePassIneligibleReason | null;
  /** When `reason` is `purchased_within_30_days`, the moment a new purchase opens up. */
  readonly nextEligibleAt: string | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export function evaluateNinePassEligibility(input: NinePassEligibilityInput): NinePassEligibility {
  if (input.currency !== "INR") {
    return { eligible: false, reason: "currency_not_inr", nextEligibleAt: null };
  }
  if (input.planKey !== "free") {
    return { eligible: false, reason: "on_paid_plan", nextEligibleAt: null };
  }
  if (input.lastPurchaseAt !== null) {
    const nextEligibleAt = new Date(
      input.lastPurchaseAt.getTime() + NINE_PASS_ELIGIBILITY_WINDOW_DAYS * MS_PER_DAY,
    );
    if (nextEligibleAt.getTime() > input.now.getTime()) {
      return {
        eligible: false,
        reason: "purchased_within_30_days",
        nextEligibleAt: nextEligibleAt.toISOString(),
      };
    }
  }
  return { eligible: true, reason: null, nextEligibleAt: null };
}
