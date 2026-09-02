/**
 * Fraud rules (brief §7, THREAT-MODEL T17). Pure predicates; the service
 * (`fraud.service.ts`) supplies the DB-derived counts/hashes.
 */

export interface SelfReferralCheckInput {
  readonly affiliateUserId: string;
  readonly referredUserId: string;
  /** IP hash recorded at the referred workspace's sign-up. */
  readonly referredIpHash?: string | null;
  readonly affiliateLastIpHash?: string | null;
  readonly referredDeviceHash?: string | null;
  readonly affiliateLastDeviceHash?: string | null;
  readonly referredPaymentFingerprint?: string | null;
  readonly affiliatePaymentFingerprint?: string | null;
}

/** Same user, same device, or same payment instrument as the affiliate itself. */
export function isSelfReferral(input: SelfReferralCheckInput): boolean {
  if (input.affiliateUserId === input.referredUserId) return true;
  if (
    input.referredDeviceHash !== null &&
    input.referredDeviceHash !== undefined &&
    input.referredDeviceHash === input.affiliateLastDeviceHash
  ) {
    return true;
  }
  if (
    input.referredPaymentFingerprint !== null &&
    input.referredPaymentFingerprint !== undefined &&
    input.referredPaymentFingerprint === input.affiliatePaymentFingerprint
  ) {
    return true;
  }
  return false;
}

export interface BurstCheckInput {
  /** Sign-ups attributed to this affiliate from one IP/device hash in the lookback window. */
  readonly signupsFromSameFingerprint: number;
}

const BURST_SIGNUP_THRESHOLD = 5;

export function isBurstSignup(input: BurstCheckInput): boolean {
  return input.signupsFromSameFingerprint >= BURST_SIGNUP_THRESHOLD;
}

export interface RefundRatioCheckInput {
  readonly totalReferrals: number;
  readonly refundedOrClawedBackReferrals: number;
}

const REFUND_RATIO_THRESHOLD = 0.3;

/** Refunds/chargebacks over 30% of an affiliate's referrals (brief §7). */
export function isRefundRatioExceeded(input: RefundRatioCheckInput): boolean {
  if (input.totalReferrals === 0) return false;
  return input.refundedOrClawedBackReferrals / input.totalReferrals > REFUND_RATIO_THRESHOLD;
}

export type FraudFlagReason =
  "self_referral" | "burst_signup" | "refund_ratio" | "payment_fingerprint_match";
