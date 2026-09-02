import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetRazorpayLoaderForTests,
  loadRazorpayCheckout,
  openRazorpayCheckout,
} from "./razorpay";

describe("loadRazorpayCheckout", () => {
  beforeEach(() => {
    __resetRazorpayLoaderForTests();
    document.head.innerHTML = "";
  });

  afterEach(() => {
    __resetRazorpayLoaderForTests();
    document.head.innerHTML = "";
  });

  it("injects the official script tag and resolves once it loads", async () => {
    const promise = loadRazorpayCheckout();
    const script = document.head.querySelector<HTMLScriptElement>(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]',
    );
    expect(script).not.toBeNull();

    // Simulate the script defining the global and firing `load`.
    window.Razorpay = class {
      open(): void {}
    } as never;
    script?.dispatchEvent(new Event("load"));

    const Razorpay = await promise;
    expect(Razorpay).toBe(window.Razorpay);
  });

  it("resolves null when the script fails to load, without throwing", async () => {
    const promise = loadRazorpayCheckout();
    const script = document.head.querySelector<HTMLScriptElement>(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]',
    );
    script?.dispatchEvent(new Event("error"));
    await expect(promise).resolves.toBeNull();
  });

  it("returns the already-loaded global without injecting a second script", async () => {
    window.Razorpay = class {
      open(): void {}
    } as never;
    const Razorpay = await loadRazorpayCheckout();
    expect(Razorpay).toBe(window.Razorpay);
    expect(document.head.querySelectorAll("script")).toHaveLength(0);
  });
});

describe("openRazorpayCheckout", () => {
  beforeEach(() => {
    __resetRazorpayLoaderForTests();
    document.head.innerHTML = "";
  });

  afterEach(() => {
    __resetRazorpayLoaderForTests();
    document.head.innerHTML = "";
  });

  it("resolves a success outcome (with the payment/order ids) once the widget's handler fires", async () => {
    let capturedOptions: { handler: (response: unknown) => void } | undefined;
    window.Razorpay = class {
      constructor(options: never) {
        capturedOptions = options;
      }
      open(): void {}
    } as never;

    const outcome = openRazorpayCheckout({
      key: "rzp_test_fake",
      amount: 69_900,
      currency: "INR",
      name: "Aksharo",
    });

    // `openRazorpayCheckout` awaits `loadRazorpayCheckout()` before
    // constructing the widget, so the constructor runs a tick or two after
    // this call returns — wait for it rather than assuming a fixed number
    // of microtasks.
    await vi.waitFor(() => {
      if (capturedOptions === undefined) throw new Error("widget not constructed yet");
    });
    capturedOptions?.handler({
      razorpay_payment_id: "pay_123",
      razorpay_order_id: "order_123",
    });

    await expect(outcome).resolves.toEqual({
      status: "success",
      paymentId: "pay_123",
      orderId: "order_123",
    });
  });

  it("resolves a dismissed outcome when the widget's modal.ondismiss fires", async () => {
    let capturedOptions: { modal: { ondismiss: () => void } } | undefined;
    window.Razorpay = class {
      constructor(options: never) {
        capturedOptions = options;
      }
      open(): void {}
    } as never;

    const outcome = openRazorpayCheckout({
      key: "rzp_test_fake",
      amount: 69_900,
      currency: "INR",
      name: "Aksharo",
    });

    await vi.waitFor(() => {
      if (capturedOptions === undefined) throw new Error("widget not constructed yet");
    });
    capturedOptions?.modal.ondismiss();

    await expect(outcome).resolves.toEqual({ status: "dismissed" });
  });

  it("rejects rather than resolving falsely when the script never loads", async () => {
    const promise = openRazorpayCheckout({
      key: "rzp_test_fake",
      amount: 69_900,
      currency: "INR",
      name: "Aksharo",
    });
    const script = document.head.querySelector<HTMLScriptElement>(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]',
    );
    script?.dispatchEvent(new Event("error"));
    await expect(promise).rejects.toThrow("Could not load Razorpay Checkout.");
  });

  it("rejects when the constructor throws (e.g. a rejected fake key)", async () => {
    window.Razorpay = class {
      constructor() {
        throw new Error("invalid key");
      }
      open(): void {}
    } as never;

    await expect(
      openRazorpayCheckout({ key: "bad", amount: 1, currency: "INR", name: "Aksharo" }),
    ).rejects.toThrow("invalid key");
  });
});
