import { describe, expect, it } from "vitest";

import {
  ALT_APP_ORIGIN,
  APP_ORIGIN,
  decidePopup,
  isNavigationAllowed,
  isOpenExternalAllowed,
} from "./allowlist.js";

describe("isNavigationAllowed", () => {
  it("allows the hosted app origin", () => {
    expect(isNavigationAllowed(`${APP_ORIGIN}/studio/projects/123`)).toBe(true);
  });

  it("allows the alt-domain app origin", () => {
    expect(isNavigationAllowed(`${ALT_APP_ORIGIN}/studio`)).toBe(true);
  });

  it("allows Google OAuth", () => {
    expect(isNavigationAllowed("https://accounts.google.com/o/oauth2/auth")).toBe(true);
  });

  it("denies an arbitrary https origin", () => {
    expect(isNavigationAllowed("https://evil.example/phish")).toBe(false);
  });

  it("denies a look-alike subdomain (prefix confusion)", () => {
    expect(isNavigationAllowed(`https://app.${new URL(APP_ORIGIN).hostname}.evil.example/`)).toBe(
      false,
    );
  });

  it("denies non-https schemes", () => {
    expect(
      isNavigationAllowed(`http://app.${new URL(APP_ORIGIN).hostname.replace("app.", "")}`),
    ).toBe(false);
    expect(isNavigationAllowed("file:///etc/passwd")).toBe(false);
    expect(isNavigationAllowed("javascript:alert(1)")).toBe(false);
  });

  it("denies malformed URLs", () => {
    expect(isNavigationAllowed("not a url")).toBe(false);
  });
});

describe("decidePopup", () => {
  it("opens Google OAuth and Razorpay in a controlled window", () => {
    expect(decidePopup("https://accounts.google.com/o/oauth2/auth")).toBe("controlled-window");
    expect(decidePopup("https://checkout.razorpay.com/v1/checkout.js")).toBe("controlled-window");
  });

  it("routes the marketing domain to the external browser", () => {
    expect(decidePopup(`https://${new URL(APP_ORIGIN).hostname.replace("app.", "")}/pricing`)).toBe(
      "external-browser",
    );
  });

  it("denies an unrecognised origin", () => {
    expect(decidePopup("https://evil.example/")).toBe("deny");
  });

  it("denies malformed URLs", () => {
    expect(decidePopup("javascript:alert(document.cookie)")).toBe("deny");
  });
});

describe("isOpenExternalAllowed", () => {
  it("allows the brand domain and payment/auth providers", () => {
    expect(
      isOpenExternalAllowed(`https://${new URL(APP_ORIGIN).hostname.replace("app.", "")}/support`),
    ).toBe(true);
    expect(isOpenExternalAllowed("https://checkout.razorpay.com/")).toBe(true);
  });

  it("denies an arbitrary external URL", () => {
    expect(isOpenExternalAllowed("https://evil.example/")).toBe(false);
  });

  it("denies non-https protocol handlers", () => {
    expect(isOpenExternalAllowed("file:///C:/Windows/System32")).toBe(false);
  });
});
