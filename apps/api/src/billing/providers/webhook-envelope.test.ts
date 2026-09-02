import { describe, expect, it } from "vitest";

import {
  deriveEventId,
  normaliseRazorpayEvent,
  parseRazorpayWebhookBody,
  signRazorpayWebhook,
  verifyRazorpayWebhookSignature,
  type RazorpayWebhookBody,
} from "./webhook-envelope.js";

const SECRET = "test_webhook_secret";

function body(overrides: Partial<RazorpayWebhookBody> = {}): RazorpayWebhookBody {
  return {
    entity: "event",
    event: "subscription.activated",
    created_at: 1_700_000_000,
    payload: { subscription: { entity: { id: "sub_123", status: "active" } } },
    ...overrides,
  };
}

describe("signRazorpayWebhook / verifyRazorpayWebhookSignature", () => {
  it("a signature made with the right secret verifies", () => {
    const raw = JSON.stringify(body());
    const signature = signRazorpayWebhook(SECRET, raw);
    expect(verifyRazorpayWebhookSignature(SECRET, raw, signature)).toBe(true);
  });

  it("a signature made with the wrong secret is rejected (the tamper case)", () => {
    const raw = JSON.stringify(body());
    const signature = signRazorpayWebhook("wrong-secret", raw);
    expect(verifyRazorpayWebhookSignature(SECRET, raw, signature)).toBe(false);
  });

  it("a mutated body invalidates a signature made for the original bytes", () => {
    const raw = JSON.stringify(body());
    const signature = signRazorpayWebhook(SECRET, raw);
    const tampered = JSON.stringify(body({ event: "subscription.cancelled" }));
    expect(verifyRazorpayWebhookSignature(SECRET, tampered, signature)).toBe(false);
  });

  it("signature comparison does not throw on a signature of different length", () => {
    const raw = JSON.stringify(body());
    expect(verifyRazorpayWebhookSignature(SECRET, raw, "short")).toBe(false);
  });
});

describe("deriveEventId", () => {
  it("is stable for the exact same body (a replay reproduces the same id)", () => {
    const first = deriveEventId(body());
    const second = deriveEventId(body());
    expect(first).toBe(second);
  });

  it("differs when the event type differs", () => {
    expect(deriveEventId(body())).not.toBe(
      deriveEventId(body({ event: "subscription.cancelled" })),
    );
  });

  it("differs when the entity id differs", () => {
    const other = body({
      payload: { subscription: { entity: { id: "sub_456", status: "active" } } },
    });
    expect(deriveEventId(body())).not.toBe(deriveEventId(other));
  });
});

describe("parseRazorpayWebhookBody", () => {
  it("parses a well-formed envelope", () => {
    const parsed = parseRazorpayWebhookBody(JSON.stringify(body()));
    expect(parsed?.event).toBe("subscription.activated");
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseRazorpayWebhookBody("{not json")).toBeUndefined();
  });

  it("returns undefined for JSON missing the envelope shape", () => {
    expect(parseRazorpayWebhookBody(JSON.stringify({ foo: "bar" }))).toBeUndefined();
  });
});

describe("normaliseRazorpayEvent", () => {
  it("reads amount/currency/status/notes off the payment entity", () => {
    const event = normaliseRazorpayEvent(
      body({
        payload: {
          subscription: {
            entity: { id: "sub_1", status: "active", notes: { workspaceId: "ws1" } },
          },
          payment: {
            entity: {
              id: "pay_1",
              status: "captured",
              amount: 69_900,
              currency: "INR",
              method: "upi",
              notes: { subscriptionId: "sub_1" },
            },
          },
        },
      }),
    );
    expect(event).toMatchObject({
      eventType: "subscription.activated",
      providerSubscriptionId: "sub_1",
      providerPaymentId: "pay_1",
      amountMinor: 69_900,
      currency: "INR",
      method: "upi",
    });
  });

  it("reads the decline code off a failed payment", () => {
    const event = normaliseRazorpayEvent(
      body({
        event: "payment.failed",
        payload: {
          payment: { entity: { id: "pay_2", status: "failed", error_code: "insufficient_funds" } },
        },
      }),
    );
    expect(event.declineCode).toBe("insufficient_funds");
  });
});
