/**
 * Error codes, audit actions and tunables `offers/` owns (CONTRACTS §8:
 * `namespace/slug`), in the same spirit as `billing/billing.constants.ts`.
 */
export const OFFERS_ERRORS = {
  /** INR-only, once per workspace per 30 days, never while on a paid plan. */
  ninePassIneligible: "offers/nine_pass_ineligible",
  /** The dev-only payment simulator was called against a live billing provider. */
  devSimulatorUnavailable: "offers/dev_simulator_unavailable",
  /** No unconsumed `first_export` pass purchase to simulate a payment for. */
  passPurchaseNotFound: "offers/pass_purchase_not_found",
} as const;

export type OffersErrorCode = (typeof OFFERS_ERRORS)[keyof typeof OFFERS_ERRORS];

/** `<domain>.<noun>.<verb>`, past tense — the convention `B01_AUDIT_ACTIONS` set. */
export const B04_AUDIT_ACTIONS = {
  ninePassRedeemed: "offers.nine_pass.redeemed",
  ninePassCheckoutRefused: "offers.nine_pass.checkout_refused",
} as const;

/** "₹9 once per account per 30 days" (04 §Offers, orchestrator addendum). */
export const NINE_PASS_ELIGIBILITY_WINDOW_DAYS = 30;

/** D55: keep the ₹9 offer if ≥ 10% of buyers reach a paid plan within 60 days. */
export const NINE_PASS_HYPOTHESIS_WINDOW_DAYS = 60;

/** D55: replace the ₹9 offer with a ₹49 three-export pack if < 6% after 500 buyers. */
export const NINE_PASS_KEEP_THRESHOLD = 0.1;
export const NINE_PASS_REPLACE_THRESHOLD = 0.06;
export const NINE_PASS_REPLACE_MIN_BUYERS = 500;
