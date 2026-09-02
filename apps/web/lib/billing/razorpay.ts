"use client";

/**
 * Razorpay Checkout.js — loaded from Razorpay's own official script URL,
 * never bundled or self-hosted. Shared by every checkout surface in the app:
 * `checkout-sheet.tsx` (plan subscriptions and their mandate) and B04's
 * one-time purchases (`ExportUpsellPanel`'s ₹9 clean export and week pass,
 * `TopupCard`'s credit top-ups).
 *
 * Neither caller trusts the widget's own success signal as "the purchase is
 * done" — THREAT-MODEL: a client can never self-report a payment as
 * complete. The payment only becomes real once Razorpay calls our webhook
 * (`POST /billing/webhooks/razorpay`); every call site here polls its own
 * source of truth afterwards (subscription status or offers eligibility).
 * `openRazorpayCheckout`'s resolved {@link RazorpayOutcome} only reports
 * whether the buyer finished the widget or dismissed it — never whether
 * anything was actually charged.
 *
 * `apps/api/src/billing/README.md`: the fake provider issues a
 * `keyId: "rzp_test_fake"` that is not a real Razorpay key, so opening the
 * real widget against it (a real network call to Razorpay's own servers)
 * cannot be made to complete a payment from a sandboxed test — the e2e
 * suites drive the webhook directly instead (`apps/web/e2e/billing.spec.ts`,
 * `apps/web/e2e/offers.spec.ts`).
 */

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
const SCRIPT_LOAD_TIMEOUT_MS = 8_000;

/** The fields every caller supplies; `handler`/`modal` are wired internally by {@link openRazorpayCheckout}. */
export interface RazorpayCheckoutOptions {
  readonly key: string;
  readonly amount: number;
  readonly currency: string;
  readonly name: string;
  readonly description?: string;
  readonly order_id?: string;
  readonly subscription_id?: string;
  readonly prefill?: { readonly email?: string; readonly contact?: string };
  readonly notes?: Record<string, string>;
  readonly theme?: { readonly color?: string };
}

interface RazorpayWidgetHandlerResponse {
  readonly razorpay_payment_id?: string;
  readonly razorpay_order_id?: string;
  readonly razorpay_subscription_id?: string;
}

interface RazorpayWidgetOptions extends RazorpayCheckoutOptions {
  readonly handler?: (response: RazorpayWidgetHandlerResponse) => void;
  readonly modal?: { readonly ondismiss?: () => void };
}

interface RazorpayInstance {
  open: () => void;
  close?: () => void;
}

type RazorpayConstructor = new (options: RazorpayWidgetOptions) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

let loadPromise: Promise<RazorpayConstructor | null> | null = null;

/**
 * Load the official script once, sharing one in-flight promise across every
 * caller. Non-throwing by design (resolves `null` on a load failure or
 * timeout) so a caller can decide for itself whether "the script never
 * loaded" is fatal — `openRazorpayCheckout` treats it as fatal (throws);
 * anything wanting a softer "did it even load" signal can call this
 * directly instead.
 */
export function loadRazorpayCheckout(): Promise<RazorpayConstructor | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.Razorpay !== undefined) return Promise.resolve(window.Razorpay);

  loadPromise ??= new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.src = CHECKOUT_SRC;
    script.async = true;

    const timeout = window.setTimeout(() => {
      resolve(null);
    }, SCRIPT_LOAD_TIMEOUT_MS);

    script.addEventListener(
      "load",
      () => {
        window.clearTimeout(timeout);
        resolve(window.Razorpay ?? null);
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => {
        window.clearTimeout(timeout);
        resolve(null);
      },
      { once: true },
    );

    if (existing === null) document.head.appendChild(script);
  });

  return loadPromise;
}

export type RazorpayOutcome =
  | { readonly status: "success"; readonly paymentId: string; readonly orderId: string }
  | { readonly status: "dismissed" };

/**
 * Open the widget and await its outcome. Rejects if the script could not be
 * loaded or the widget failed to construct — `checkout-sheet.tsx` catches
 * around this to show a "could not open" note without dead-ending the sheet
 * (the webhook-driven poll still carries the flow either way); `TopupCard`
 * and `ExportUpsellPanel` catch around it to show a toast.
 */
export async function openRazorpayCheckout(
  options: RazorpayCheckoutOptions,
): Promise<RazorpayOutcome> {
  const Razorpay = await loadRazorpayCheckout();
  if (Razorpay === null) {
    throw new Error("Could not load Razorpay Checkout.");
  }

  return new Promise<RazorpayOutcome>((resolve, reject) => {
    try {
      const instance = new Razorpay({
        ...options,
        handler: (response) => {
          resolve({
            status: "success",
            paymentId: response.razorpay_payment_id ?? "",
            orderId: response.razorpay_order_id ?? response.razorpay_subscription_id ?? "",
          });
        },
        modal: {
          ondismiss: () => {
            resolve({ status: "dismissed" });
          },
        },
      });
      instance.open();
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Could not open Razorpay Checkout."));
    }
  });
}

/** Test seam: forget the cached load so a test can re-drive it against a fresh mock. */
export function __resetRazorpayLoaderForTests(): void {
  loadPromise = null;
  if (typeof window !== "undefined") delete window.Razorpay;
}
