/**
 * The checkout sheet's step machine, as a pure reducer.
 *
 * Pure so the flow — tax profile → method → confirm → gateway/polling →
 * success/failed, plus the `mandate_cap_exceeded` detour — is assertable
 * without mounting a component, a `Sheet` or a network mock (component tests
 * for "plan table math and gating" per the B03 brief §8). `checkout-sheet.tsx`
 * is the thin shell that dispatches into this and renders whatever `step` it
 * lands on.
 */

import { exceedsUpiAutopayCap } from "./money";

import type {
  BillingInterval,
  CheckoutAlternative,
  CheckoutRequest,
  CheckoutResponse,
  MandateMethod,
  PlanKey,
} from "./types";

export type CheckoutStep = "tax_profile" | "method" | "confirm" | "gateway" | "success" | "failed";

export interface CheckoutSelection {
  readonly planKey: PlanKey;
  readonly interval: BillingInterval;
  readonly seats?: number;
  readonly method?: MandateMethod;
}

export interface CheckoutFlowState {
  readonly step: CheckoutStep;
  readonly selection: CheckoutSelection;
  readonly submitting: boolean;
  readonly response: CheckoutResponse | null;
  readonly alternatives: readonly CheckoutAlternative[] | null;
  readonly error: string | null;
  readonly gatewayOpened: boolean;
}

export type CheckoutAction =
  | { readonly type: "OPEN"; readonly selection: CheckoutSelection; readonly taxConfirmed: boolean }
  | { readonly type: "TAX_PROFILE_CONFIRMED" }
  | { readonly type: "METHOD_SELECTED"; readonly method?: MandateMethod }
  | { readonly type: "APPLY_ALTERNATIVE"; readonly alternative: CheckoutAlternative }
  | { readonly type: "SUBMIT" }
  | { readonly type: "CHECKOUT_SUCCESS"; readonly response: CheckoutResponse }
  | {
      readonly type: "CHECKOUT_MANDATE_CAP_EXCEEDED";
      readonly alternatives: readonly CheckoutAlternative[];
    }
  | { readonly type: "CHECKOUT_ERROR"; readonly message: string }
  | { readonly type: "GATEWAY_OPENED" }
  | { readonly type: "GATEWAY_FAILED_TO_OPEN" }
  | { readonly type: "SUBSCRIPTION_STATUS"; readonly status: string }
  | { readonly type: "RESET" };

export function initialCheckoutState(): CheckoutFlowState {
  return {
    step: "tax_profile",
    selection: { planKey: "creator", interval: "month" },
    submitting: false,
    response: null,
    alternatives: null,
    error: null,
    gatewayOpened: false,
  };
}

/** `active` is the only status that unlocks entitlements — everything else keeps polling. */
export function classifySubscriptionStatus(status: string): "success" | "failed" | "pending" {
  if (status === "active") return "success";
  if (status === "cancelled" || status === "expired") return "failed";
  return "pending";
}

export function checkoutFlowReducer(
  state: CheckoutFlowState,
  action: CheckoutAction,
): CheckoutFlowState {
  switch (action.type) {
    case "OPEN":
      return {
        ...initialCheckoutState(),
        selection: action.selection,
        step: action.taxConfirmed ? "method" : "tax_profile",
      };

    case "TAX_PROFILE_CONFIRMED":
      return state.step === "tax_profile" ? { ...state, step: "method", error: null } : state;

    case "METHOD_SELECTED":
      return {
        ...state,
        step: "confirm",
        selection:
          action.method === undefined
            ? state.selection
            : { ...state.selection, method: action.method },
        error: null,
      };

    case "APPLY_ALTERNATIVE":
      return {
        ...state,
        step: "confirm",
        selection: {
          ...state.selection,
          interval: action.alternative.interval,
          method: action.alternative.method,
        },
        alternatives: null,
        error: null,
      };

    case "SUBMIT":
      return { ...state, submitting: true, error: null };

    case "CHECKOUT_SUCCESS":
      return {
        ...state,
        submitting: false,
        response: action.response,
        step: "gateway",
        alternatives: null,
      };

    case "CHECKOUT_MANDATE_CAP_EXCEEDED":
      return {
        ...state,
        submitting: false,
        step: "method",
        alternatives: action.alternatives,
        error: "A UPI Autopay mandate cannot exceed ₹15,000 at this interval.",
      };

    case "CHECKOUT_ERROR":
      return { ...state, submitting: false, error: action.message };

    case "GATEWAY_OPENED":
      return { ...state, gatewayOpened: true };

    case "GATEWAY_FAILED_TO_OPEN":
      return { ...state, gatewayOpened: false };

    case "SUBSCRIPTION_STATUS": {
      const outcome = classifySubscriptionStatus(action.status);
      if (outcome === "pending") return state;
      return { ...state, step: outcome };
    }

    case "RESET":
      return initialCheckoutState();

    default:
      return state;
  }
}

/** The request body `POST /billing/checkout` expects, from the flow's selection. */
export function toCheckoutRequest(selection: CheckoutSelection): CheckoutRequest {
  return {
    planKey: selection.planKey,
    interval: selection.interval,
    ...(selection.seats === undefined ? {} : { seats: selection.seats }),
    ...(selection.method === undefined ? {} : { method: selection.method }),
  };
}

/**
 * Client-side hint only (see `money.ts`'s header comment): `true` when the
 * selected plan/interval/currency combination would be refused as a UPI
 * Autopay mandate, so the method step can grey the option out before the
 * round trip. The server's `409 billing/mandate_cap_exceeded` is still
 * handled either way.
 */
export function upiAutopayLikelyRefused(listPriceMinor: number, currency: "INR" | "USD"): boolean {
  return currency === "INR" && exceedsUpiAutopayCap(listPriceMinor);
}
