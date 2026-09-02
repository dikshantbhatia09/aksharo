/**
 * B13 scope §2: "refund + credit note (B01 + B05) with policy checks (within
 * 7 days full; pro-rata otherwise; reason codes)".
 *
 * Pure function, unit-testable without a database: given the purchase's age
 * and what the lot it granted still has unspent, decide how much of the
 * original payment is refundable.
 */
const FULL_REFUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RefundPolicyInput {
  readonly purchasedAt: Date;
  readonly now: Date;
  readonly baseAmountMinor: number;
  /** `credit_lots.granted_tenths` for the lot this purchase created. */
  readonly grantedTenths: number;
  /** `credit_lots.remaining_tenths` for the same lot, right now. */
  readonly remainingTenths: number;
}

export interface RefundPolicyResult {
  readonly policy: "full" | "pro_rata";
  readonly refundAmountMinor: number;
}

export function computeRefundPolicy(input: RefundPolicyInput): RefundPolicyResult {
  const ageMs = input.now.getTime() - input.purchasedAt.getTime();
  if (ageMs <= FULL_REFUND_WINDOW_MS) {
    return { policy: "full", refundAmountMinor: input.baseAmountMinor };
  }

  // Pro-rata by how much of what was paid for is still unspent. A lot with
  // nothing granted (defensive — should not happen for a real purchase)
  // refunds nothing rather than dividing by zero.
  const fraction =
    input.grantedTenths > 0
      ? Math.min(1, Math.max(0, input.remainingTenths / input.grantedTenths))
      : 0;
  const refundAmountMinor = Math.floor(input.baseAmountMinor * fraction);
  return { policy: "pro_rata", refundAmountMinor };
}
