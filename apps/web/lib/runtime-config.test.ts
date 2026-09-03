import { afterEach, describe, expect, it, vi } from "vitest";

import { readRuntimeConfig } from "./runtime-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readRuntimeConfig provider availability", () => {
  it("hides Google OAuth unless both client values are configured", () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "secret");
    expect(readRuntimeConfig().googleOAuthEnabled).toBe(false);

    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-id");
    expect(readRuntimeConfig().googleOAuthEnabled).toBe(true);
  });

  it("enables checkout only for a complete Razorpay credential set", () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "key-id");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "key-secret");
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "");
    expect(readRuntimeConfig().razorpayEnabled).toBe(false);

    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "webhook-secret");
    expect(readRuntimeConfig().razorpayEnabled).toBe(true);
  });

  it("exposes auto-verification only for the dev mail outbox", () => {
    vi.stubEnv("AUTH_DEV_AUTO_VERIFY", "1");
    vi.stubEnv("MAIL_PROVIDER", "dev");
    expect(readRuntimeConfig().authDevAutoVerify).toBe(true);

    vi.stubEnv("MAIL_PROVIDER", "smtp");
    expect(readRuntimeConfig().authDevAutoVerify).toBe(false);
  });
});
