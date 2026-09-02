/**
 * Razorpay Checkout loader (B04).
 *
 * The web app never talks to Razorpay's API directly — `POST
 * /billing/passes/checkout` and `POST /billing/topups/checkout` return an
 * order plus a `keyId`, and this file's only job is to load Razorpay's own
 * `checkout.js` and open the widget with that order. Nothing here decides an
 * amount or grants anything: the payment only becomes real once Razorpay
 * calls our webhook (`POST /billing/webhooks/razorpay`), which is why every
 * caller of {@link openRazorpayCheckout} treats its resolution as "the buyer
 * finished the widget", not "the pass is granted" — see `ExportUpsellPanel`'s
 * poll-after-success comment.
 */

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => { open: () => void };
  }
}

export interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  order_id: string;
  prefill?: { email?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  handler: (response: { razorpay_payment_id: string; razorpay_order_id: string }) => void;
  modal?: { ondismiss?: () => void };
}

let loading: Promise<void> | null = null;

/** Injects `checkout.js` once and resolves when `window.Razorpay` is ready. */
export function loadRazorpayCheckout(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Razorpay Checkout only loads in the browser."));
  }
  if (window.Razorpay !== undefined) return Promise.resolve();
  if (loading !== null) return loading;

  loading = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.addEventListener("load", () => {
      resolve();
    });
    script.addEventListener("error", () => {
      loading = null;
      reject(new Error("Could not load Razorpay Checkout."));
    });
    if (existing === null) document.head.appendChild(script);
  });
  return loading;
}

export type RazorpayOutcome =
  { status: "success"; paymentId: string; orderId: string } | { status: "dismissed" };

/** Loads `checkout.js` if needed, then opens the widget and awaits its result. */
export async function openRazorpayCheckout(
  options: Omit<RazorpayOptions, "handler" | "modal">,
): Promise<RazorpayOutcome> {
  await loadRazorpayCheckout();
  const Razorpay = window.Razorpay;
  if (Razorpay === undefined) {
    throw new Error("Razorpay Checkout did not initialise.");
  }

  return new Promise<RazorpayOutcome>((resolve) => {
    const instance = new Razorpay({
      ...options,
      handler: (response) => {
        resolve({
          status: "success",
          paymentId: response.razorpay_payment_id,
          orderId: response.razorpay_order_id,
        });
      },
      modal: {
        ondismiss: () => {
          resolve({ status: "dismissed" });
        },
      },
    });
    instance.open();
  });
}
