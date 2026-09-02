/**
 * Constants for the give-get referral loop (D53, F-607, B07b).
 */

/** Tenths of a credit granted to each side on a successful referral ("30/30"). */
export const REFERRAL_REWARD_TENTHS = 300;

/** Tenths of a credit for the tiered bonus (13-launch-plan: "3 referrals → 100 bonus credits"). */
export const REFERRAL_BONUS_TENTHS = 1000;

/** Granted referrals needed to trigger the once-only tiered bonus. */
export const REFERRAL_BONUS_THRESHOLD = 3;

/** Free workspaces receive at most this many *granted* referrer rewards per calendar month. */
export const REFERRAL_FREE_MONTHLY_CAP = 10;

/** Referral codes are `AK-XXXXXX` — distinct from `affiliates.code`, which has no fixed prefix. */
export const REFERRAL_CODE_PREFIX = "AK-";

export const REFERRAL_REJECT_REASONS = {
  cap: "cap",
  selfReferral: "self_referral",
  sameDevice: "same_device",
  disposableEmail: "disposable_email",
  minor: "minor",
} as const;

export type ReferralRejectReason =
  (typeof REFERRAL_REJECT_REASONS)[keyof typeof REFERRAL_REJECT_REASONS];

/** B13 orchestrator addendum (after B07b): the review window for "chained self-referral". */
export const CHAINED_SELF_REFERRAL_WINDOW_DAYS = 90;

export const REFERRAL_HOLD_REASONS = {
  chainedSelfReferral: "chained_self_referral",
} as const;

export type ReferralHoldReason = (typeof REFERRAL_HOLD_REASONS)[keyof typeof REFERRAL_HOLD_REASONS];
