/**
 * Error codes owned by the credits domain (CONTRACTS §8: `namespace/slug`).
 *
 * `credits/insufficient` and `credits/needs_credits` are named in
 * `07-api-and-contracts.md §Conventions` and already live in
 * `common/errors/error-codes.ts` (A08); this file adds the ones specific to the
 * ledger's own operations, which nothing outside B02 throws.
 */
export const CREDIT_ERROR_CODES = {
  /**
   * `reverse()` was called for a job with no prior hold to inherit an expiry
   * from. The caller (an admin refund, or B01's payment-refund path) must name a
   * job that actually ran and was settled.
   */
  reversalSourceNotFound: "credits/reversal_source_not_found",
  /** A hold id that never existed and was never created by `reserve()`. */
  holdNotFound: "credits/hold_not_found",
} as const;

export type CreditErrorCode = (typeof CREDIT_ERROR_CODES)[keyof typeof CREDIT_ERROR_CODES];
