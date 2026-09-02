import { Injectable, Logger } from "@nestjs/common";

import type {
  CreatePayoutInput,
  PayoutProvider,
  PayoutProviderResult,
  PayoutProviderStatus,
} from "./payout-provider.js";

const RAZORPAYX_BASE_URL = "https://api.razorpay.com/v1";

/**
 * RazorpayX Payouts (brief §5). There are no RazorpayX keys in this
 * environment (`README.md` "Manual live-key smoke test") — every test and
 * every local run in this work package goes through `FakePayoutProvider`
 * instead (`payout.factory.ts`). Call shapes here follow the public RazorpayX
 * Payouts API (`POST /v1/payouts`, fund-account-first) since, unlike
 * `billing/providers/razorpay.provider.ts`, there is no vendored SDK source
 * to read the request/response shape from — flagged as unverified until a
 * real RazorpayX account exercises it (see README).
 */
@Injectable()
export class RazorpayXProvider implements PayoutProvider {
  private readonly logger = new Logger(RazorpayXProvider.name);

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly accountNumber: string,
  ) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`;
  }

  async createPayout(input: CreatePayoutInput): Promise<PayoutProviderResult> {
    // Fund account creation is intentionally not implemented — RazorpayX
    // requires a `contact` + `fund_account` to exist before a payout can
    // reference it, which needs a live account to design and test against.
    // `apps/api/src/affiliates/README.md` documents the manual steps an
    // operator runs once real keys land; this method is unreachable in this
    // environment (`payout.factory.ts` never selects this class here).
    // A fixed, trusted API host — not a user-supplied URL, so `safeFetch`'s
    // SSRF-guard machinery (built for imports from an arbitrary URL) does not
    // apply; plain `fetch` against a hardcoded RazorpayX domain is correct
    // here, the same as `billing/providers/razorpay.provider.ts`'s SDK calls.
    const response = await fetch(`${RAZORPAYX_BASE_URL}/payouts`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        "X-Payout-Idempotency": input.idempotencyKey,
      },
      body: JSON.stringify({
        account_number: this.accountNumber,
        amount: input.amountMinor,
        currency: input.currency,
        mode: input.method.rail.toUpperCase(),
        purpose: "payout",
        queue_if_low_balance: true,
        narration: input.narration,
      }),
    });
    if (!response.ok) {
      this.logger.error({ status: response.status }, "RazorpayX payout call failed");
      throw new Error(`RazorpayX payout failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      id: string;
      status: string;
      fees?: number;
      utr?: string;
    };
    return {
      providerRef: body.id,
      status: mapStatus(body.status),
      providerFeeMinor: body.fees ?? 0,
      utr: body.utr,
    };
  }

  async getPayoutStatus(providerRef: string): Promise<PayoutProviderResult> {
    const response = await fetch(`${RAZORPAYX_BASE_URL}/payouts/${providerRef}`, {
      method: "GET",
      headers: { Authorization: this.authHeader() },
    });
    if (!response.ok) throw new Error(`RazorpayX payout status failed: HTTP ${response.status}`);
    const body = (await response.json()) as {
      id: string;
      status: string;
      fees?: number;
      utr?: string;
    };
    return {
      providerRef: body.id,
      status: mapStatus(body.status),
      providerFeeMinor: body.fees ?? 0,
      utr: body.utr,
    };
  }
}

function mapStatus(razorpayxStatus: string): PayoutProviderStatus {
  switch (razorpayxStatus) {
    case "processed":
      return "processed";
    case "processing":
    case "queued":
      return razorpayxStatus === "processing" ? "processing" : "queued";
    case "reversed":
      return "reversed";
    case "rejected":
    case "cancelled":
    case "failed":
      return "failed";
    default:
      return "processing";
  }
}
