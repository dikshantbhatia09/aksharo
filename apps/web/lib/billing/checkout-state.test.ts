import { describe, expect, it } from "vitest";

import {
  checkoutFlowReducer,
  classifySubscriptionStatus,
  initialCheckoutState,
  toCheckoutRequest,
  upiAutopayLikelyRefused,
} from "./checkout-state";

import type { CheckoutAlternative, CheckoutResponse } from "./types";

describe("classifySubscriptionStatus", () => {
  it("is success only for active", () => {
    expect(classifySubscriptionStatus("active")).toBe("success");
  });

  it("is failed for cancelled or expired", () => {
    expect(classifySubscriptionStatus("cancelled")).toBe("failed");
    expect(classifySubscriptionStatus("expired")).toBe("failed");
  });

  it("is pending for pending, past_due, halted or paused", () => {
    for (const status of ["pending", "past_due", "halted", "paused"]) {
      expect(classifySubscriptionStatus(status)).toBe("pending");
    }
  });
});

describe("checkoutFlowReducer", () => {
  it("opens on the tax-profile step when the workspace has not confirmed one", () => {
    const state = checkoutFlowReducer(initialCheckoutState(), {
      type: "OPEN",
      selection: { planKey: "creator", interval: "month" },
      taxConfirmed: false,
    });
    expect(state.step).toBe("tax_profile");
  });

  it("skips straight to the method step when the tax profile is already confirmed", () => {
    const state = checkoutFlowReducer(initialCheckoutState(), {
      type: "OPEN",
      selection: { planKey: "creator", interval: "month" },
      taxConfirmed: true,
    });
    expect(state.step).toBe("method");
  });

  it("moves tax_profile -> method on confirmation", () => {
    const opened = checkoutFlowReducer(initialCheckoutState(), {
      type: "OPEN",
      selection: { planKey: "creator", interval: "month" },
      taxConfirmed: false,
    });
    const next = checkoutFlowReducer(opened, { type: "TAX_PROFILE_CONFIRMED" });
    expect(next.step).toBe("method");
  });

  it("ignores TAX_PROFILE_CONFIRMED once already past that step", () => {
    const state: ReturnType<typeof checkoutFlowReducer> = {
      ...initialCheckoutState(),
      step: "method",
    };
    expect(checkoutFlowReducer(state, { type: "TAX_PROFILE_CONFIRMED" }).step).toBe("method");
  });

  it("records the method and moves to confirm", () => {
    const state = { ...initialCheckoutState(), step: "method" as const };
    const next = checkoutFlowReducer(state, { type: "METHOD_SELECTED", method: "upi_autopay" });
    expect(next.step).toBe("confirm");
    expect(next.selection.method).toBe("upi_autopay");
  });

  it("SUBMIT -> CHECKOUT_SUCCESS moves to the gateway step with the response attached", () => {
    const response: CheckoutResponse = {
      subscriptionId: "sub_1",
      status: "pending",
      keyId: "rzp_test_fake",
      amountMinor: 69_900,
      currency: "INR",
      interval: "month",
      mandateCapMinor: 69_900,
      method: "upi_autopay",
    };
    const submitted = checkoutFlowReducer(
      { ...initialCheckoutState(), step: "confirm" },
      { type: "SUBMIT" },
    );
    expect(submitted.submitting).toBe(true);
    const succeeded = checkoutFlowReducer(submitted, { type: "CHECKOUT_SUCCESS", response });
    expect(succeeded.step).toBe("gateway");
    expect(succeeded.submitting).toBe(false);
    expect(succeeded.response).toBe(response);
  });

  it("CHECKOUT_MANDATE_CAP_EXCEEDED sends the flow back to method with alternatives", () => {
    const alternatives: CheckoutAlternative[] = [
      {
        kind: "halfyear_upi",
        interval: "halfyear",
        method: "upi_autopay",
        amountMinor: 999_600,
        currency: "INR",
      },
      {
        kind: "card_once",
        interval: "year",
        method: "card",
        amountMinor: 1_999_200,
        currency: "INR",
      },
    ];
    const submitted = checkoutFlowReducer(
      { ...initialCheckoutState(), step: "confirm" },
      { type: "SUBMIT" },
    );
    const refused = checkoutFlowReducer(submitted, {
      type: "CHECKOUT_MANDATE_CAP_EXCEEDED",
      alternatives,
    });
    expect(refused.step).toBe("method");
    expect(refused.alternatives).toBe(alternatives);
    expect(refused.error).not.toBeNull();
  });

  it("APPLY_ALTERNATIVE adopts the alternative's interval and method and clears the list", () => {
    const alternative = {
      kind: "halfyear_upi" as const,
      interval: "halfyear" as const,
      method: "upi_autopay" as const,
      amountMinor: 999_600,
      currency: "INR" as const,
    };
    const state = {
      ...initialCheckoutState(),
      step: "method" as const,
      alternatives: [alternative],
    };
    const next = checkoutFlowReducer(state, { type: "APPLY_ALTERNATIVE", alternative });
    expect(next.step).toBe("confirm");
    expect(next.selection.interval).toBe("halfyear");
    expect(next.selection.method).toBe("upi_autopay");
    expect(next.alternatives).toBeNull();
  });

  it("SUBSCRIPTION_STATUS 'active' resolves the gateway step to success", () => {
    const state = { ...initialCheckoutState(), step: "gateway" as const };
    const next = checkoutFlowReducer(state, { type: "SUBSCRIPTION_STATUS", status: "active" });
    expect(next.step).toBe("success");
  });

  it("SUBSCRIPTION_STATUS 'pending' leaves the step unchanged (still polling)", () => {
    const state = { ...initialCheckoutState(), step: "gateway" as const };
    const next = checkoutFlowReducer(state, { type: "SUBSCRIPTION_STATUS", status: "pending" });
    expect(next.step).toBe("gateway");
  });

  it("SUBSCRIPTION_STATUS 'cancelled' resolves to failed", () => {
    const state = { ...initialCheckoutState(), step: "gateway" as const };
    const next = checkoutFlowReducer(state, { type: "SUBSCRIPTION_STATUS", status: "cancelled" });
    expect(next.step).toBe("failed");
  });

  it("RESET returns to the initial state regardless of where the flow was", () => {
    const state = { ...initialCheckoutState(), step: "success" as const, submitting: true };
    expect(checkoutFlowReducer(state, { type: "RESET" })).toEqual(initialCheckoutState());
  });
});

describe("toCheckoutRequest", () => {
  it("omits seats and method when not selected", () => {
    expect(toCheckoutRequest({ planKey: "creator", interval: "month" })).toEqual({
      planKey: "creator",
      interval: "month",
    });
  });

  it("includes seats and method when present", () => {
    expect(
      toCheckoutRequest({ planKey: "agency", interval: "month", seats: 5, method: "card" }),
    ).toEqual({ planKey: "agency", interval: "month", seats: 5, method: "card" });
  });
});

describe("upiAutopayLikelyRefused", () => {
  it("is true for Studio yearly INR (₹19,992 > ₹15,000)", () => {
    expect(upiAutopayLikelyRefused(1_999_200, "INR")).toBe(true);
  });

  it("is false for Creator monthly INR", () => {
    expect(upiAutopayLikelyRefused(69_900, "INR")).toBe(false);
  });

  it("is always false for USD (no UPI concept — D39)", () => {
    expect(upiAutopayLikelyRefused(50_000_00, "USD")).toBe(false);
  });
});
