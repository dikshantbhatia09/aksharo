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

  it("constructs the widget with the given options and calls open()", async () => {
    const open = vi.fn();
    window.Razorpay = class {
      constructor(public options: unknown) {}
      open = open;
    } as never;

    const opened = await openRazorpayCheckout({
      key: "rzp_test_fake",
      amount: 69_900,
      currency: "INR",
      name: "Aksharo",
    });

    expect(opened).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });

  it("returns false rather than throwing when the script never loads", async () => {
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
    await expect(promise).resolves.toBe(false);
  });

  it("returns false when the constructor throws (e.g. a rejected fake key)", async () => {
    window.Razorpay = class {
      constructor() {
        throw new Error("invalid key");
      }
      open(): void {}
    } as never;

    await expect(
      openRazorpayCheckout({ key: "bad", amount: 1, currency: "INR", name: "Aksharo" }),
    ).resolves.toBe(false);
  });
});
