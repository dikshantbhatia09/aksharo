import { beforeEach, describe, expect, it } from "vitest";

import { BillingSignatureError } from "../provider.js";
import { FakeProvider } from "./fake.provider.js";

let provider: FakeProvider;

beforeEach(() => {
  provider = new FakeProvider();
});

describe("FakeProvider — subscriptions and orders", () => {
  it("creates a customer once per workspace, idempotently", async () => {
    const first = await provider.createCustomer({ workspaceId: "ws1", email: "a@example.test" });
    const second = await provider.createCustomer({ workspaceId: "ws1", email: "a@example.test" });
    expect(second.providerCustomerId).toBe(first.providerCustomerId);
  });

  it("creates a subscription with a mandate id and a checkout payload", async () => {
    const result = await provider.createSubscription({
      providerCustomerId: "cust_1",
      planKey: "creator",
      subscriptionId: "sub_internal_1",
      interval: "month",
      currency: "INR",
      amountMinor: 69_900,
      mandateCapMinor: 69_900,
      method: "upi_autopay",
    });
    expect(result.providerSubscriptionId).toMatch(/^sub_fake_/);
    expect(result.providerMandateId).toMatch(/^token_fake_/);
    expect(result.checkout).toMatchObject({
      keyId: "rzp_test_fake",
      amountMinor: 69_900,
      currency: "INR",
    });
  });

  it("creates a one-time order without a mandate", async () => {
    const result = await provider.createOrder({
      amountMinor: 29_900,
      currency: "INR",
      purpose: "starter (once, pay-once)",
      refId: "sub_internal_2",
    });
    expect(result.providerOrderId).toMatch(/^order_fake_/);
    expect(result.checkout.providerOrderId).toBe(result.providerOrderId);
  });
});

describe("FakeProvider — webhook signature (THREAT-MODEL T16)", () => {
  it("a correctly signed webhook parses to a normalised event", async () => {
    const created = await provider.createSubscription({
      providerCustomerId: "cust_1",
      planKey: "creator",
      subscriptionId: "sub_internal_1",
      interval: "month",
      currency: "INR",
      amountMinor: 69_900,
      mandateCapMinor: 69_900,
      method: "upi_autopay",
    });
    const { rawBody, signature } = provider.emitWebhook({
      event: "subscription.activated",
      providerSubscriptionId: created.providerSubscriptionId,
      status: "active",
    });
    const event = provider.parseWebhook(rawBody, signature);
    expect(event.eventType).toBe("subscription.activated");
    expect(event.providerSubscriptionId).toBe(created.providerSubscriptionId);
  });

  it("replaying the exact same webhook derives the exact same event id", async () => {
    const created = await provider.createSubscription({
      providerCustomerId: "cust_1",
      planKey: "creator",
      subscriptionId: "sub_internal_1",
      interval: "month",
      currency: "INR",
      amountMinor: 69_900,
      mandateCapMinor: 69_900,
      method: "upi_autopay",
    });
    const emitted = provider.emitWebhook({
      event: "subscription.activated",
      providerSubscriptionId: created.providerSubscriptionId,
      status: "active",
    });
    const first = provider.parseWebhook(emitted.rawBody, emitted.signature);
    const second = provider.parseWebhook(emitted.rawBody, emitted.signature);
    expect(second.eventId).toBe(first.eventId);
  });

  it("a tampered signature is rejected with BillingSignatureError (401 acceptance criterion)", async () => {
    const { rawBody } = provider.emitWebhook({ event: "subscription.activated" });
    const wrongSignature = provider.signWrong(rawBody);
    expect(() => provider.parseWebhook(rawBody, wrongSignature)).toThrow(BillingSignatureError);
  });

  it("a garbage signature is rejected the same way", () => {
    const { rawBody } = provider.emitWebhook({ event: "subscription.activated" });
    expect(() => provider.parseWebhook(rawBody, "not-a-real-signature")).toThrow(
      BillingSignatureError,
    );
  });
});

describe("FakeProvider — refunds and payment methods", () => {
  it("records every refund call", async () => {
    await provider.refund({ providerPaymentId: "pay_1", amountMinor: 1_000 });
    expect(provider.refunds).toEqual([{ providerPaymentId: "pay_1", amountMinor: 1_000 }]);
  });

  it("lists no payment methods for an unknown customer", async () => {
    expect(await provider.listPaymentMethods({ providerCustomerId: "cust_ghost" })).toEqual([]);
  });

  it("lists payment methods once a customer has been created", async () => {
    const { providerCustomerId } = await provider.createCustomer({
      workspaceId: "ws1",
      email: "a@example.test",
    });
    const methods = await provider.listPaymentMethods({ providerCustomerId });
    expect(methods.length).toBeGreaterThan(0);
  });
});
