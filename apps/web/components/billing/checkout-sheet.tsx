"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import * as React from "react";

import { isApiError, useSession } from "@montaj/api-client";
import {
  Button,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@montaj/ui";

import { TaxProfileStep } from "./tax-profile-step";

import type { CheckoutAlternative, Currency, MandateMethod, PlanView } from "@/lib/billing/types";

import { track } from "@/lib/analytics/posthog";
import {
  checkoutFlowReducer,
  initialCheckoutState,
  toCheckoutRequest,
  upiAutopayLikelyRefused,
  type CheckoutSelection,
} from "@/lib/billing/checkout-state";
import {
  useCheckout,
  usePlans,
  useSubscriptionStatusPolling,
  useWorkspaceBilling,
} from "@/lib/billing/hooks";
import { formatMoney, gstBreakup, INTERVAL_LABEL, MANDATE_METHOD_LABEL } from "@/lib/billing/money";
import { openRazorpayCheckout } from "@/lib/billing/razorpay";
import { messageForError } from "@/lib/errors";

export interface CheckoutSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly selection: CheckoutSelection;
  /** Called once the subscription reaches `active` — the caller refreshes entitlements. */
  readonly onSuccess?: () => void;
}

const STEP_LABEL: Record<string, string> = {
  tax_profile: "Billing details",
  method: "Payment method",
  confirm: "Confirm",
  gateway: "Payment",
  success: "Done",
  failed: "Payment failed",
};

/**
 * The shared checkout sheet `UpgradeGate` opens and the Plans page opens
 * directly. Steps: tax profile (skipped once already confirmed) → method
 * (skipped for a pay-once purchase, which is never mandated) → confirm →
 * gateway (Razorpay Checkout.js + webhook-driven polling) → success/failed.
 */
export function CheckoutSheet({
  open,
  onOpenChange,
  selection,
  onSuccess,
}: CheckoutSheetProps): React.JSX.Element {
  const [state, dispatch] = React.useReducer(checkoutFlowReducer, initialCheckoutState());
  const session = useSession();
  const billing = useWorkspaceBilling();
  const plans = usePlans();
  const checkout = useCheckout();
  const [gatewayNote, setGatewayNote] = React.useState<string | null>(null);

  const taxConfirmed =
    billing.data?.billingCountryConfirmedAt !== null && billing.data !== undefined;
  const isOwner = session?.role === "owner";

  // Re-open at step 1 (or 2, if the tax profile is already confirmed) whenever
  // the sheet opens for a new selection — a stale "success" screen from a
  // previous purchase must never greet the next one. Held until the
  // workspace's billing profile has actually loaded (`!billing.isPending`):
  // deciding the starting step from `taxConfirmed` before that query settles
  // would always read "unconfirmed" (the fetch has not returned yet) and land
  // an already-confirmed workspace on the tax-profile step regardless.
  const openKey = `${String(open)}:${selection.planKey}:${selection.interval}:${selection.seats ?? ""}`;
  const lastOpenKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!open || billing.isPending || lastOpenKey.current === openKey) return;
    lastOpenKey.current = openKey;
    dispatch({ type: "OPEN", selection, taxConfirmed });
    setGatewayNote(null);
    track("billing_checkout_opened", { planKey: selection.planKey, interval: selection.interval });
  }, [openKey, open, billing.isPending, taxConfirmed, selection]);

  const plan = plans.data?.find((candidate) => candidate.key === selection.planKey);
  const currency = billing.data?.currency ?? "INR";
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const prices = plan?.prices[currency];
  const amountForInterval =
    prices === undefined || selection.interval === "once"
      ? prices?.month
      : selection.interval === "halfyear"
        ? prices.halfyear
        : prices[selection.interval];

  const polling = useSubscriptionStatusPolling(state.step === "gateway");
  React.useEffect(() => {
    const status = polling.data?.status;
    if (status === undefined) return;
    dispatch({ type: "SUBSCRIPTION_STATUS", status });
  }, [polling.data?.status]);

  React.useEffect(() => {
    if (state.step === "success") {
      track("billing_checkout_succeeded", { planKey: selection.planKey });
      onSuccess?.();
    }
  }, [state.step]);

  // Open the real Razorpay Checkout.js widget once the checkout payload
  // arrives. `openRazorpayCheckout` now resolves the widget's outcome
  // (success/dismissed) or rejects if it could not even open — either way
  // the webhook-driven poll above (`useSubscriptionStatusPolling`) is the
  // real source of truth, so a rejection here only shows a note rather than
  // dead-ending the sheet.
  const openedForSubscriptionId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (state.step !== "gateway" || state.response === null) return;
    if (openedForSubscriptionId.current === state.response.subscriptionId) return;
    openedForSubscriptionId.current = state.response.subscriptionId;
    const response = state.response;
    let cancelled = false;

    openRazorpayCheckout({
      key: response.keyId,
      amount: response.amountMinor,
      currency: response.currency,
      name: "Aksharo",
      ...(response.providerOrderId === undefined ? {} : { order_id: response.providerOrderId }),
      ...(response.providerSubscriptionId === undefined
        ? {}
        : { subscription_id: response.providerSubscriptionId }),
      ...(response.prefill === undefined ? {} : { prefill: response.prefill }),
      ...(response.notes === undefined ? {} : { notes: response.notes }),
      // The gateway widget is Razorpay's own iframe: it takes a literal, not
      // a CSS variable. This is `--color-accent` written out.
      theme: { color: "#9184d9" },
    })
      .then((outcome) => {
        if (cancelled) return;
        dispatch({ type: "GATEWAY_OPENED" });
        if (outcome.status === "success") {
          void polling.refetch();
        } else {
          setGatewayNote(
            "The payment window was closed. If you completed payment, this updates automatically once we hear from Razorpay.",
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        dispatch({ type: "GATEWAY_FAILED_TO_OPEN" });
        setGatewayNote(
          "The payment window could not open. This can happen on a restricted network — we'll still update automatically once payment completes.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [state.step, state.response]);

  const submitCheckout = (): void => {
    dispatch({ type: "SUBMIT" });
    checkout.mutate(toCheckoutRequest(state.selection), {
      onSuccess: (response) => {
        dispatch({ type: "CHECKOUT_SUCCESS", response });
      },
      onError: (error) => {
        if (isApiError(error) && error.code === "billing/mandate_cap_exceeded") {
          const alternatives =
            (error.details as { alternatives?: typeof state.alternatives } | undefined)
              ?.alternatives ?? [];
          dispatch({ type: "CHECKOUT_MANDATE_CAP_EXCEEDED", alternatives });
          return;
        }
        dispatch({ type: "CHECKOUT_ERROR", message: messageForError(error) });
      },
    });
  };

  const close = (): void => {
    onOpenChange(false);
    dispatch({ type: "RESET" });
  };

  const chooseMethod = (method: MandateMethod): void => {
    dispatch({ type: "METHOD_SELECTED", method });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent data-testid="checkout-sheet">
        <SheetHeader>
          <SheetTitle>{STEP_LABEL[state.step]}</SheetTitle>
          <SheetDescription>
            {plan?.name ?? selection.planKey} · {INTERVAL_LABEL[selection.interval]}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-4" data-testid={`checkout-step-${state.step}`}>
          {billing.isPending || plans.isPending ? (
            <p className="text-fg-2 text-sm" data-testid="checkout-loading">
              Preparing checkout…
            </p>
          ) : (
            <>
              {state.step === "tax_profile" ? (
                <TaxProfileStep
                  billing={billing.data}
                  isOwner={isOwner}
                  onConfirmed={() => {
                    dispatch({ type: "TAX_PROFILE_CONFIRMED" });
                  }}
                />
              ) : null}

              {state.step === "method" ? (
                <MethodStep
                  selection={state.selection}
                  amountMinor={amountForInterval}
                  currency={currency}
                  plan={plan}
                  alternatives={state.alternatives}
                  error={state.error}
                  onChooseMethod={chooseMethod}
                  onApplyAlternative={(alternative) => {
                    dispatch({ type: "APPLY_ALTERNATIVE", alternative });
                  }}
                />
              ) : null}

              {state.step === "confirm" ? (
                <ConfirmStep
                  selection={state.selection}
                  amountMinor={amountForInterval}
                  currency={currency}
                  submitting={state.submitting}
                  error={state.error}
                  onConfirm={submitCheckout}
                />
              ) : null}

              {state.step === "gateway" ? (
                <div
                  className="flex flex-col items-center gap-3 py-6 text-center"
                  data-testid="checkout-processing"
                >
                  <Loader2 className="text-lime-500 size-8 animate-spin" aria-hidden="true" />
                  <p className="text-fg-0 text-sm font-medium">Waiting for payment confirmation…</p>
                  <p className="text-fg-2 text-xs">
                    This updates automatically the moment Razorpay confirms the payment — usually
                    within a few seconds.
                  </p>
                  {gatewayNote === null ? null : (
                    <p className="text-warning text-xs" data-testid="checkout-gateway-note">
                      {gatewayNote}
                    </p>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void polling.refetch();
                    }}
                  >
                    Check again
                  </Button>
                </div>
              ) : null}

              {state.step === "success" ? (
                <div
                  className="flex flex-col items-center gap-3 py-6 text-center"
                  data-testid="checkout-success"
                >
                  <CheckCircle2 className="text-accepted size-10" aria-hidden="true" />
                  <p className="text-fg-0 text-base font-medium">
                    You're on {plan?.name ?? "the new plan"}
                  </p>
                  <p className="text-fg-2 text-sm">
                    Everything unlocks right away — no reload needed.
                  </p>
                  <Button variant="primary" onClick={close} data-testid="checkout-done">
                    Done
                  </Button>
                </div>
              ) : null}

              {state.step === "failed" ? (
                <div
                  className="flex flex-col items-center gap-3 py-6 text-center"
                  data-testid="checkout-failed"
                >
                  <XCircle className="text-rejected size-10" aria-hidden="true" />
                  <p className="text-fg-0 text-base font-medium">That payment did not go through</p>
                  <p className="text-fg-2 text-sm">Nothing was charged for a cancelled mandate.</p>
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={close}>
                      Close
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => {
                        dispatch({ type: "OPEN", selection, taxConfirmed });
                      }}
                    >
                      Try again
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function MethodStep({
  selection,
  amountMinor,
  currency,
  plan,
  alternatives,
  error,
  onChooseMethod,
  onApplyAlternative,
}: {
  readonly selection: CheckoutSelection;
  readonly amountMinor: number | undefined;
  readonly currency: Currency;
  readonly plan: PlanView | undefined;
  readonly alternatives: readonly CheckoutAlternative[] | null;
  readonly error: string | null;
  readonly onChooseMethod: (method: MandateMethod) => void;
  readonly onApplyAlternative: (alternative: CheckoutAlternative) => void;
}): React.JSX.Element {
  if (selection.interval === "once") {
    return (
      <div className="flex flex-col gap-4" data-testid="method-pay-once">
        <p className="text-fg-1 text-sm">
          A 30-day one-time purchase — no mandate, no auto-renew. We'll remind you before it
          expires.
        </p>
        <Button
          variant="primary"
          onClick={() => {
            onChooseMethod("card");
          }}
        >
          Continue
        </Button>
      </div>
    );
  }

  const overCap = amountMinor !== undefined && upiAutopayLikelyRefused(amountMinor, currency);
  const showHalfyearHint =
    selection.interval === "year" && currency === "INR" && plan?.hasHalfyear.INR === true;

  return (
    <div className="flex flex-col gap-4" data-testid="method-step">
      <p className="text-fg-1 text-sm">
        UPI Autopay auto-renews with a capped mandate — never charged above ₹15,000 per debit. Card
        and eNACH have no such ceiling but need fresh authentication above it.
      </p>

      {showHalfyearHint ? (
        <p
          className="border-info/40 bg-info/10 text-fg-1 rounded-sm border p-3 text-xs"
          data-testid="halfyear-explainer"
        >
          A yearly UPI Autopay mandate cannot exceed ₹15,000, so a Studio yearly subscription over
          UPI is billed as <strong>two half-yearly debits</strong> instead of one yearly charge — or
          choose Card for a single charge.
        </p>
      ) : null}

      {error !== null ? (
        <p className="text-rejected text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          className="justify-between"
          disabled={overCap}
          data-testid="method-upi_autopay"
          onClick={() => {
            onChooseMethod("upi_autopay");
          }}
        >
          <span>UPI Autopay</span>
          {overCap ? <span className="text-fg-2 text-xs">Over ₹15,000 cap</span> : null}
        </Button>
        <Button
          variant="outline"
          data-testid="method-card"
          onClick={() => {
            onChooseMethod("card");
          }}
        >
          Card
        </Button>
        <Button variant="outline" disabled data-testid="method-netbanking" aria-disabled="true">
          Netbanking (coming soon — use Card)
        </Button>
      </div>

      {alternatives !== null && alternatives.length > 0 ? (
        <div className="border-border flex flex-col gap-2 rounded-md border border-dashed p-3">
          <p className="text-fg-0 text-sm font-medium">Try one of these instead</p>
          {alternatives.map((alternative) => (
            <Button
              key={alternative.kind}
              variant="ghost"
              className="justify-between"
              data-testid={`alternative-${alternative.kind}`}
              onClick={() => {
                onApplyAlternative(alternative);
              }}
            >
              <span>
                {alternative.kind === "halfyear_upi"
                  ? "Half-yearly UPI Autopay"
                  : alternative.kind === "card_once"
                    ? "One-time card charge"
                    : "eNACH"}
              </span>
              <span className="text-fg-2 text-xs">
                {formatMoney(alternative.amountMinor, alternative.currency)}
              </span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ConfirmStep({
  selection,
  amountMinor,
  currency,
  submitting,
  error,
  onConfirm,
}: {
  readonly selection: CheckoutSelection;
  readonly amountMinor: number | undefined;
  readonly currency: Currency;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const breakup = currency === "INR" && amountMinor !== undefined ? gstBreakup(amountMinor) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="confirm-step">
      <div className="flex flex-col gap-1">
        <p className="text-fg-2 text-xs">
          {INTERVAL_LABEL[selection.interval]} ·{" "}
          {selection.seats !== undefined ? `${String(selection.seats)} seats · ` : ""}
          {selection.method !== undefined ? MANDATE_METHOD_LABEL[selection.method] : "Pay once"}
        </p>
        <p className="text-fg-0 text-2xl font-semibold" data-testid="confirm-amount">
          {amountMinor === undefined ? "—" : formatMoney(amountMinor, currency)}
        </p>
        {breakup === null ? null : (
          <p className="text-fg-2 text-xs" data-testid="confirm-gst-breakup">
            incl. 18% GST — {formatMoney(breakup.taxableValueMinor, "INR")} +{" "}
            {formatMoney(breakup.gstMinor, "INR")} GST
          </p>
        )}
      </div>

      {error !== null ? (
        <p className="text-rejected text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <Button variant="primary" disabled={submitting} data-testid="confirm-pay" onClick={onConfirm}>
        {submitting ? "Starting…" : "Pay now"}
      </Button>
    </div>
  );
}
