import type { $Enums } from "@prisma/client";

/**
 * The currency-lock rule (04 §Tax, D41; B01 orchestrator addendum after A05,
 * ruling on open question 3).
 *
 * Pure, so it is assertable without a database — the same reasoning
 * `tax-profile.ts` gives for `validateTaxProfile`. `workspaces.service.ts`'s
 * `lockedWorkspaces()` is the integration point: it cannot avoid a database
 * query (workspaces and their subscriptions/invoices live there), but the
 * *rule* — which states count, and that a zero-priced plan never locks — is
 * exactly what belongs here.
 */

/** Subscription states that count toward the lock, if the price is non-zero. */
export const LIVE_SUBSCRIPTION_STATES: readonly $Enums.SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "paused",
];

const LIVE_SUBSCRIPTION_STATE_SET: ReadonlySet<$Enums.SubscriptionStatus> = new Set(
  LIVE_SUBSCRIPTION_STATES,
);

/**
 * Whether one subscription locks its workspace's currency: live status **and**
 * a non-zero list price. A Free subscription (`listPriceMinor: 0`) never
 * locks, no matter its status — `prisma/seed.ts` gives the demo workspace
 * exactly this shape, and it must stay editable.
 */
export function subscriptionLocksCurrency(
  status: $Enums.SubscriptionStatus,
  listPriceMinor: number,
): boolean {
  return LIVE_SUBSCRIPTION_STATE_SET.has(status) && listPriceMinor > 0;
}

/** Whether one invoice locks its workspace's currency: any invoice that has been paid. */
export function invoiceLocksCurrency(status: $Enums.InvoiceStatus): boolean {
  return status === "paid";
}
