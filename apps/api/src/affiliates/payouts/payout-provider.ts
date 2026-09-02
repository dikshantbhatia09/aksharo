/**
 * The port every affiliate payout goes through (brief §5: "RazorpayX payout
 * API behind a `PayoutProvider` interface (fake for tests)"), the same shape
 * `billing/provider.ts`'s `BillingProvider` takes for subscriptions.
 */

export type PayoutRail = "neft" | "imps" | "rtgs" | "upi";

export interface PayoutMethod {
  readonly rail: PayoutRail;
  /** UPI VPA, or bank account number (already tokenised — `affiliates.payoutMethod`). */
  readonly vpaOrAccountNumber: string;
  readonly ifsc?: string;
  readonly accountHolderName: string;
}

export interface CreatePayoutInput {
  readonly affiliateId: string;
  /** Net amount actually transferred (gross minus TDS), in paise. */
  readonly amountMinor: number;
  readonly currency: "INR";
  readonly method: PayoutMethod;
  /** Idempotency key — one payout batch line must never double-fire against a retry. */
  readonly idempotencyKey: string;
  readonly narration: string;
}

export type PayoutProviderStatus = "queued" | "processing" | "processed" | "failed" | "reversed";

export interface PayoutProviderResult {
  readonly providerRef: string;
  readonly status: PayoutProviderStatus;
  readonly providerFeeMinor: number;
  readonly utr?: string;
}

export interface PayoutProvider {
  createPayout(input: CreatePayoutInput): Promise<PayoutProviderResult>;
  getPayoutStatus(providerRef: string): Promise<PayoutProviderResult>;
}

export const PAYOUT_PROVIDER = Symbol("PAYOUT_PROVIDER");
