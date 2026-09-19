/**
 * Error codes, audit actions and limits `billing/` owns (CONTRACTS §8:
 * `namespace/slug`). `billing/mandate_cap_exceeded` is already central
 * (`common/errors/error-codes.ts`, named in `07-api-and-contracts.md
 * §Conventions`); everything else specific to this module lives here, exactly
 * as `JOB_ERROR_CODES` does for `jobs/`.
 */
export const BILLING_ERRORS = {
  planNotFound: "billing/plan_not_found",
  planInactive: "billing/plan_inactive",
  intervalUnavailable: "billing/interval_unavailable",
  /** A05's `billingCountryConfirmedAt` is still null (orchestrator addendum, after A04). */
  taxProfileRequired: "billing/tax_profile_required",
  subscriptionNotFound: "billing/subscription_not_found",
  subscriptionNotCancellable: "billing/subscription_not_cancellable",
  subscriptionNotResumable: "billing/subscription_not_resumable",
  /** Pause is once per 12 months (04 §Refunds & cancellation). */
  pauseLimitReached: "billing/pause_limit_reached",
  alreadyPaused: "billing/already_paused",
  mandateNotFound: "billing/mandate_not_found",
  mandateAlreadyRevoked: "billing/mandate_already_revoked",
  topupInvalid: "billing/topup_invalid",
  passKindUnavailable: "billing/pass_kind_unavailable",
  checkoutPending: "billing/checkout_pending",
  /** Signature failed, or the body could not be parsed (THREAT-MODEL T16). */
  webhookSignatureInvalid: "billing/webhook_signature_invalid",
  providerRejected: "billing/provider_rejected",
  passPurchaseNotFound: "billing/pass_purchase_not_found",
  alreadyRefunded: "billing/already_refunded",
  checkoutDisabled: "billing/checkout_disabled",
} as const;

export type BillingErrorCode = (typeof BILLING_ERRORS)[keyof typeof BILLING_ERRORS];

/** `<domain>.<noun>.<verb>`, past tense — the convention `A05_AUDIT_ACTIONS` set. */
export const B01_AUDIT_ACTIONS = {
  checkoutCreated: "billing.checkout.created",
  checkoutRefused: "billing.checkout.refused",
  passCheckoutCreated: "billing.pass_checkout.created",
  topupCheckoutCreated: "billing.topup_checkout.created",
  passGranted: "billing.pass.granted",
  webhookProcessed: "billing.webhook.processed",
  webhookIgnored: "billing.webhook.ignored",
  webhookMismatch: "billing.webhook.amount_mismatch",
  webhookReplayed: "billing.webhook.replayed",
  subscriptionActivated: "billing.subscription.activated",
  subscriptionRenewed: "billing.subscription.renewed",
  subscriptionPastDue: "billing.subscription.past_due",
  subscriptionCancelled: "billing.subscription.cancelled",
  subscriptionResumed: "billing.subscription.resumed",
  subscriptionPaused: "billing.subscription.paused",
  subscriptionExpired: "billing.subscription.expired",
  subscriptionChanged: "billing.subscription.plan_changed",
  mandateRegistered: "billing.mandate.registered",
  mandateRevoked: "billing.mandate.revoked",
  renewalInitiated: "billing.renewal.initiated",
  dunningStepped: "billing.dunning.stepped",
  refundIssued: "billing.refund.issued",
  creditsClawedBack: "billing.credits.clawed_back",
  /** `CreditsFacade.reverse()` could not apply — see billing/README.md "grant clawback". */
  creditsClawbackUnavailable: "billing.credits.clawback_unavailable",
} as const;

/** UPI Autopay's AFA-free recurring ceiling (RBI, D05/D40): ₹15,000 in paise. */
export const UPI_AUTOPAY_CAP_MINOR = 1_500_000;

/** 3-day entitlement grace after a renewal charge starts failing (D40). */
export const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1_000;

/** Renewal is initiated at least 48h before period end (D40, RBI 24h notice + headroom). */
export const RENEWAL_INITIATE_LEAD_MS = 48 * 60 * 60 * 1_000;

/** Pre-debit notices go out at least 24h before the charge (RBI e-mandate framework). */
export const PRE_DEBIT_NOTICE_LEAD_MS = 24 * 60 * 60 * 1_000;

/** Pause is once per rolling 12 months (04 §Refunds & cancellation). */
export const PAUSE_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1_000;

/** Top-up packs available to every workspace (04 §Offers, §Plans). */
export const TOPUP_TIERS = [
  { credits: 100, prices: { INR: 14_900, USD: 300 }, minPlan: null },
  { credits: 500, prices: { INR: 89_900, USD: 1_700 }, minPlan: "starter" },
  { credits: 2_000, prices: { INR: 299_900, USD: 5_900 }, minPlan: "starter" },
] as const;

/** ₹9 clean export: INR only — 04 §Offers gives no USD figure for it. */
export const FIRST_EXPORT_PRICE_INR_MINOR = 900;

/** ₹59 / $1.50 week pass: 7 days of Starter, 40 credits, no mandate (04 §Offers). */
export const WEEK_PASS = {
  days: 7,
  creditsTenths: 400,
  prices: { INR: 5_900, USD: 150 },
} as const;
