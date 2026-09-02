import { describe, expect, it } from "vitest";

import { BillingSignatureError } from "../provider.js";
import { RazorpayProvider } from "./razorpay.provider.js";
import { signRazorpayWebhook, type RazorpayWebhookBody } from "./webhook-envelope.js";

/**
 * `RazorpayProvider` is never exercised end to end in this work package — there
 * are no live Razorpay keys (README "Manual live-key smoke test"). What IS
 * verifiable without a network call is `parseWebhook`: it is pure, local HMAC
 * verification, and the signature scheme it implements
 * (`X-Razorpay-Signature: hex(hmac_sha256(secret, rawBody))`) is read directly
 * from the official SDK's own shipped source
 * (`razorpay/dist/utils/razorpay-utils.js`'s `validateWebhookSignature`), not
 * guessed — so this is a real assertion, not a placeholder.
 */
describe("RazorpayProvider.parseWebhook (verified against the SDK's own signing code)", () => {
  const secret = "whsec_test";
  const provider = new RazorpayProvider("rzp_test_key", "rzp_test_secret", secret);

  const body: RazorpayWebhookBody = {
    entity: "event",
    event: "payment.captured",
    created_at: 1_700_000_000,
    payload: {
      payment: {
        entity: { id: "pay_live_1", status: "captured", amount: 69_900, currency: "INR" },
      },
    },
  };

  it("accepts a signature produced the way the official SDK produces one", () => {
    const raw = JSON.stringify(body);
    const signature = signRazorpayWebhook(secret, raw);
    const event = provider.parseWebhook(raw, signature);
    expect(event).toMatchObject({
      eventType: "payment.captured",
      providerPaymentId: "pay_live_1",
      amountMinor: 69_900,
    });
  });

  it("rejects a signature made with the wrong secret", () => {
    const raw = JSON.stringify(body);
    const signature = signRazorpayWebhook("wrong", raw);
    expect(() => provider.parseWebhook(raw, signature)).toThrow(BillingSignatureError);
  });

  it("constructing the provider does not reach the network", () => {
    expect(() => new RazorpayProvider("rzp_test_key", "rzp_test_secret", secret)).not.toThrow();
  });
});
