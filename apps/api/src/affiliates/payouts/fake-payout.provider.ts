import { Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import type { CreatePayoutInput, PayoutProvider, PayoutProviderResult } from "./payout-provider.js";

/**
 * In-memory `PayoutProvider` (README "Manual live-key smoke test" pattern
 * `billing/providers/fake.provider.ts` set): deterministic ids, no network
 * call, every acceptance test in this work package runs against it because
 * there are no RazorpayX keys in this environment.
 */
@Injectable()
export class FakePayoutProvider implements PayoutProvider {
  private readonly logger = new Logger(FakePayoutProvider.name);
  private readonly byRef = new Map<string, PayoutProviderResult>();
  private readonly byIdempotencyKey = new Map<string, PayoutProviderResult>();

  async createPayout(input: CreatePayoutInput): Promise<PayoutProviderResult> {
    const existing = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existing !== undefined) return existing;

    const result: PayoutProviderResult = {
      providerRef: `fake_payout_${ulid()}`,
      status: "processed",
      providerFeeMinor: Math.min(500, Math.round(input.amountMinor * 0.0002)), // ~2 bps, capped ₹5
      utr: `FAKEUTR${ulid().slice(-10)}`,
    };
    this.byRef.set(result.providerRef, result);
    this.byIdempotencyKey.set(input.idempotencyKey, result);
    this.logger.log(
      { affiliateId: input.affiliateId, ref: result.providerRef },
      "fake payout created",
    );
    return result;
  }

  async getPayoutStatus(providerRef: string): Promise<PayoutProviderResult> {
    const found = this.byRef.get(providerRef);
    if (found === undefined) throw new Error(`unknown fake payout ref: ${providerRef}`);
    return found;
  }
}
