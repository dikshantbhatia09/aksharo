import { Logger } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { FakeProvider } from "./fake.provider.js";
import { RazorpayProvider } from "./razorpay.provider.js";

import type { BillingProvider } from "../provider.js";

const logger = new Logger("BillingProviderFactory");

/**
 * `RazorpayProvider` when `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`/
 * `RAZORPAY_WEBHOOK_SECRET` are all set, `FakeProvider` otherwise — exactly the
 * shape `notify/mail.factory.ts` uses for `MAIL_PROVIDER`.
 *
 * There are no live Razorpay keys in this environment (README "Manual live-key
 * smoke test"), so every boot of this API in this work package runs on the fake
 * — which is deliberate: every test and every local run exercises the same
 * webhook envelope, signature scheme and state machine the real provider will
 * hit, with nothing to configure. Setting the three variables in `.env` when
 * A00-02 lands is the whole cutover; nothing else in `billing/` changes.
 */
export function createBillingProvider(env: Env): BillingProvider {
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = env;
  if (
    RAZORPAY_KEY_ID !== undefined &&
    RAZORPAY_KEY_ID !== "" &&
    RAZORPAY_KEY_SECRET !== undefined &&
    RAZORPAY_KEY_SECRET !== "" &&
    RAZORPAY_WEBHOOK_SECRET !== undefined &&
    RAZORPAY_WEBHOOK_SECRET !== ""
  ) {
    logger.log("billing provider: Razorpay (live keys configured)");
    return new RazorpayProvider(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET);
  }
  logger.warn(
    "billing provider: FAKE (no RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET) — " +
      "no payment ever reaches a real account from this process",
  );
  return new FakeProvider(RAZORPAY_WEBHOOK_SECRET === "" ? undefined : RAZORPAY_WEBHOOK_SECRET);
}
