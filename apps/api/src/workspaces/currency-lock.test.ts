import { describe, expect, it } from "vitest";

import {
  invoiceLocksCurrency,
  LIVE_SUBSCRIPTION_STATES,
  subscriptionLocksCurrency,
} from "./currency-lock.js";

describe("subscriptionLocksCurrency (B01 orchestrator addendum, after A05)", () => {
  it("a live, non-zero-priced subscription locks", () => {
    for (const status of LIVE_SUBSCRIPTION_STATES) {
      expect(subscriptionLocksCurrency(status, 69_900)).toBe(true);
    }
  });

  it("a zero-priced (Free) subscription never locks, regardless of status", () => {
    for (const status of LIVE_SUBSCRIPTION_STATES) {
      expect(subscriptionLocksCurrency(status, 0)).toBe(false);
    }
  });

  it("a finished subscription (cancelled/expired) never locks, even at a non-zero price", () => {
    expect(subscriptionLocksCurrency("cancelled", 69_900)).toBe(false);
    expect(subscriptionLocksCurrency("expired", 69_900)).toBe(false);
  });

  it("a pending (not yet authenticated) subscription does not lock", () => {
    // `pending` is B01's own addition to the enum (checkout created, awaiting
    // the first charge) — deliberately absent from LIVE_SUBSCRIPTION_STATES,
    // since nothing has been paid yet.
    expect(subscriptionLocksCurrency("pending", 69_900)).toBe(false);
  });
});

describe("invoiceLocksCurrency", () => {
  it("only a paid invoice locks", () => {
    expect(invoiceLocksCurrency("paid")).toBe(true);
    expect(invoiceLocksCurrency("draft")).toBe(false);
    expect(invoiceLocksCurrency("issued")).toBe(false);
    expect(invoiceLocksCurrency("cancelled")).toBe(false);
    expect(invoiceLocksCurrency("void")).toBe(false);
  });
});
