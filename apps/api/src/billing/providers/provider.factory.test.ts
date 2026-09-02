import { describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { FakeProvider } from "./fake.provider.js";
import { createBillingProvider } from "./provider.factory.js";
import { RazorpayProvider } from "./razorpay.provider.js";

function envWith(overrides: Partial<Env>): Env {
  return {
    RAZORPAY_KEY_ID: undefined,
    RAZORPAY_KEY_SECRET: undefined,
    RAZORPAY_WEBHOOK_SECRET: undefined,
    ...overrides,
  } as Env;
}

describe("createBillingProvider — mirrors notify/mail.factory.ts's MAIL_PROVIDER switch", () => {
  it("falls back to FakeProvider when any of the three Razorpay variables is missing", () => {
    expect(createBillingProvider(envWith({}))).toBeInstanceOf(FakeProvider);
    expect(createBillingProvider(envWith({ RAZORPAY_KEY_ID: "rzp_id" }))).toBeInstanceOf(
      FakeProvider,
    );
    expect(
      createBillingProvider(
        envWith({ RAZORPAY_KEY_ID: "rzp_id", RAZORPAY_KEY_SECRET: "rzp_secret" }),
      ),
    ).toBeInstanceOf(FakeProvider);
    expect(
      createBillingProvider(
        envWith({ RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w" }),
      ),
    ).toBeInstanceOf(FakeProvider);
  });

  it("uses RazorpayProvider once all three live keys are configured", () => {
    const provider = createBillingProvider(
      envWith({
        RAZORPAY_KEY_ID: "rzp_id",
        RAZORPAY_KEY_SECRET: "rzp_secret",
        RAZORPAY_WEBHOOK_SECRET: "whsec",
      }),
    );
    expect(provider).toBeInstanceOf(RazorpayProvider);
  });
});
