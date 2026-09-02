import { describe, expect, it } from "vitest";

import { computeRefundPolicy } from "./admin-refund-policy.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("computeRefundPolicy", () => {
  it("refunds in full within the 7-day window, regardless of usage", () => {
    const result = computeRefundPolicy({
      purchasedAt: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2026-01-07T23:59:59Z"),
      baseAmountMinor: 90000,
      grantedTenths: 1000,
      remainingTenths: 100, // mostly spent — still full within the window
    });
    expect(result).toEqual({ policy: "full", refundAmountMinor: 90000 });
  });

  it("refunds in full exactly at the 7-day boundary", () => {
    const result = computeRefundPolicy({
      purchasedAt: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2026-01-08T00:00:00Z"),
      baseAmountMinor: 90000,
      grantedTenths: 1000,
      remainingTenths: 1000,
    });
    expect(result.policy).toBe("full");
  });

  it("pro-rates by the fraction of credits still unspent after 7 days", () => {
    const result = computeRefundPolicy({
      purchasedAt: new Date("2026-01-01T00:00:00Z"),
      now: new Date(new Date("2026-01-01T00:00:00Z").getTime() + 8 * DAY_MS),
      baseAmountMinor: 100000,
      grantedTenths: 1000,
      remainingTenths: 250, // 25% unspent
    });
    expect(result).toEqual({ policy: "pro_rata", refundAmountMinor: 25000 });
  });

  it("refunds nothing when fully spent, past the window", () => {
    const result = computeRefundPolicy({
      purchasedAt: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2026-02-01T00:00:00Z"),
      baseAmountMinor: 100000,
      grantedTenths: 1000,
      remainingTenths: 0,
    });
    expect(result).toEqual({ policy: "pro_rata", refundAmountMinor: 0 });
  });

  it("never divides by zero when the lot recorded nothing granted", () => {
    const result = computeRefundPolicy({
      purchasedAt: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2026-02-01T00:00:00Z"),
      baseAmountMinor: 100000,
      grantedTenths: 0,
      remainingTenths: 0,
    });
    expect(result).toEqual({ policy: "pro_rata", refundAmountMinor: 0 });
  });

  it("never refunds more than what was paid, even if remaining exceeds granted", () => {
    const result = computeRefundPolicy({
      purchasedAt: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2026-02-01T00:00:00Z"),
      baseAmountMinor: 100000,
      grantedTenths: 1000,
      remainingTenths: 5000, // defensive: should not happen, must still clamp to 1x
    });
    expect(result.refundAmountMinor).toBeLessThanOrEqual(100000);
  });
});
