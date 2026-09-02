import { describe, expect, it } from "vitest";

import { classifyDecline } from "./dunning.js";

describe("classifyDecline — each decline code class handled distinctly (B01 brief §7)", () => {
  it("a mandate-cancelled code offers a fallback immediately, no retry", () => {
    const step = classifyDecline("india_recurring_payment_mandate_canceled", 0);
    expect(step).toMatchObject({ bucket: "mandate", action: "offer_fallback", exhausted: true });
  });

  it("a mandate-invalid code is the same bucket regardless of casing", () => {
    expect(classifyDecline("PAYMENT_INTENT_MANDATE_INVALID", 0).bucket).toBe("mandate");
  });

  it("a card problem offers a fallback immediately", () => {
    const step = classifyDecline("expired_card", 0);
    expect(step).toMatchObject({ bucket: "card", action: "offer_fallback" });
  });

  it("insufficient funds gets a short retry ladder", () => {
    const first = classifyDecline("insufficient_funds", 0);
    expect(first).toMatchObject({
      bucket: "insufficient_funds",
      action: "retry",
      exhausted: false,
    });
    expect(first.retryDelayMs).toBeGreaterThan(0);
  });

  it("insufficient funds stops retrying once the ladder is exhausted", () => {
    const exhausted = classifyDecline("insufficient_funds", 3);
    expect(exhausted).toMatchObject({
      bucket: "insufficient_funds",
      action: "offer_fallback",
      exhausted: true,
    });
    expect(exhausted.retryDelayMs).toBeUndefined();
  });

  it("`transaction_not_approved` and `do_not_honor` fall into the generic bucket with a longer ladder", () => {
    expect(classifyDecline("transaction_not_approved", 0)).toMatchObject({
      bucket: "generic",
      action: "retry",
    });
    expect(classifyDecline("do_not_honor", 0)).toMatchObject({
      bucket: "generic",
      action: "retry",
    });
  });

  it("a missing decline code is treated as generic, not a crash", () => {
    expect(classifyDecline(undefined, 0)).toMatchObject({ bucket: "generic" });
    expect(classifyDecline(null, 0)).toMatchObject({ bucket: "generic" });
  });

  it("generic exhausts after its own maxAttempts, independent of the other buckets", () => {
    const step = classifyDecline("some_unknown_code", 3);
    expect(step).toMatchObject({
      bucket: "generic",
      action: "offer_fallback",
      exhausted: true,
      maxAttempts: 3,
    });
  });
});
