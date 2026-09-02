import { Logger } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { FakePayoutProvider } from "./fake-payout.provider.js";
import { RazorpayXProvider } from "./razorpayx.provider.js";

import type { PayoutProvider } from "./payout-provider.js";

const logger = new Logger("PayoutProviderFactory");

/**
 * `RazorpayXProvider` when live RazorpayX credentials are configured,
 * `FakePayoutProvider` otherwise — the same shape `billing/providers/
 * provider.factory.ts` uses for `BillingProvider`. There are no RazorpayX
 * keys in this environment, so every test and every local run of this work
 * package goes through the fake (README "Manual live-key smoke test").
 *
 * Reuses `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` (same Razorpay account,
 * different API surface) rather than adding new frozen-contract env vars;
 * `RAZORPAYX_ACCOUNT_NUMBER` is additional and optional, read directly from
 * `process.env` since it is not part of `docs/CONTRACTS.md §1`.
 */
export function createPayoutProvider(env: Env): PayoutProvider {
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = env;
  const accountNumber = process.env["RAZORPAYX_ACCOUNT_NUMBER"];
  if (
    RAZORPAY_KEY_ID !== undefined &&
    RAZORPAY_KEY_ID !== "" &&
    RAZORPAY_KEY_SECRET !== undefined &&
    RAZORPAY_KEY_SECRET !== "" &&
    accountNumber !== undefined &&
    accountNumber !== ""
  ) {
    logger.log("payout provider: RazorpayX (live keys configured)");
    return new RazorpayXProvider(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, accountNumber);
  }
  logger.warn(
    "payout provider: FAKE (no RAZORPAY_KEY_ID/KEY_SECRET or RAZORPAYX_ACCOUNT_NUMBER) — " +
      "no payout ever reaches a real bank account from this process",
  );
  return new FakePayoutProvider();
}
