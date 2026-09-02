"use client";

/**
 * Razorpay Checkout.js — loaded from Razorpay's own official script URL, never
 * bundled or self-hosted (the brief is explicit: "loaded from Razorpay's
 * official script URL").
 *
 * The widget is the production payment surface; it is not how this work
 * package's own tests reach success. `apps/api/src/billing/README.md`: the
 * fake provider issues a `keyId: "rzp_test_fake"` that is not a real Razorpay
 * key, so opening the real widget against it (a real network call to
 * Razorpay's own servers) cannot be made to complete a payment from a
 * sandboxed test. Instead, `checkout-sheet.tsx` polls
 * `GET /billing/subscription` for the status change the webhook produces —
 * the same signal a real payment would eventually cause — and the e2e suite
 * drives that webhook directly (see `apps/web/e2e/billing.spec.ts`). Loading
 * or opening the widget is therefore treated as best-effort here: a failure
 * to load (a blocked script in a locked-down environment, an ad blocker) logs
 * and lets the polling path carry the flow rather than dead-ending the sheet.
 */

const SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
const SCRIPT_LOAD_TIMEOUT_MS = 8_000;

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
  readonly handler?: (response: unknown) => void;
  readonly modal?: { readonly ondismiss?: () => void };
}

interface RazorpayInstance {
  open: () => void;
  close?: () => void;
}

type RazorpayConstructor = new (options: RazorpayCheckoutOptions) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

let loadPromise: Promise<RazorpayConstructor | null> | null = null;

/** Load the official script once, sharing one in-flight promise across callers. */
export function loadRazorpayCheckout(): Promise<RazorpayConstructor | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.Razorpay !== undefined) return Promise.resolve(window.Razorpay);

  loadPromise ??= new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.src = SCRIPT_SRC;
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

/**
 * Open the widget. Resolves `true` once `open()` has been called (not once
 * payment completes — the caller polls for that), `false` when the script
 * could not be loaded at all.
 */
export async function openRazorpayCheckout(options: RazorpayCheckoutOptions): Promise<boolean> {
  const Razorpay = await loadRazorpayCheckout();
  if (Razorpay === null) return false;
  try {
    new Razorpay(options).open();
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget the cached load so a test can re-drive it against a fresh mock. */
export function __resetRazorpayLoaderForTests(): void {
  loadPromise = null;
  if (typeof window !== "undefined") delete window.Razorpay;
}
