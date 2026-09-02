import { GRACE_PERIOD_MS, RENEWAL_INITIATE_LEAD_MS } from "./billing.constants.js";

import type { $Enums } from "@prisma/client";

/**
 * Billing-period arithmetic (B01 brief §2, D40). Pure functions, asserted
 * without a database — the same reasoning `money.ts` documents.
 */

/** `once` is a fixed 30-day period (B01 brief §2: "30-day pass-once"). */
const ONCE_DAYS = 30;

/** End of the current billing period, given when it started. */
export function periodEnd(start: Date, interval: $Enums.BillingInterval): Date {
  const end = new Date(start);
  switch (interval) {
    case "month":
      end.setUTCMonth(end.getUTCMonth() + 1);
      return end;
    case "halfyear":
      end.setUTCMonth(end.getUTCMonth() + 6);
      return end;
    case "year":
      // "Pay 10 months, get 12" (04 §Offers): the *charge* is 10 months, the
      // *period* the customer is entitled to is the full 12.
      end.setUTCFullYear(end.getUTCFullYear() + 1);
      return end;
    case "once":
      end.setUTCDate(end.getUTCDate() + ONCE_DAYS);
      return end;
  }
}

/** ≥ 48h before period end (D40: 24h RBI pre-debit notice + gateway hold + retry headroom). */
export function renewalInitiateAt(periodEndAt: Date): Date {
  return new Date(periodEndAt.getTime() - RENEWAL_INITIATE_LEAD_MS);
}

/** 3-day entitlement grace once a renewal charge starts failing (D40). */
export function graceUntil(periodEndAt: Date): Date {
  return new Date(periodEndAt.getTime() + GRACE_PERIOD_MS);
}
