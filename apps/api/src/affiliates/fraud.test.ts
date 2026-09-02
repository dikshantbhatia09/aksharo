import { describe, expect, it } from "vitest";

import { isBurstSignup, isRefundRatioExceeded, isSelfReferral } from "./fraud.js";

describe("isSelfReferral (brief §7)", () => {
  it("flags the same user id", () => {
    expect(isSelfReferral({ affiliateUserId: "u1", referredUserId: "u1" })).toBe(true);
  });

  it("flags a different account on the same device", () => {
    expect(
      isSelfReferral({
        affiliateUserId: "u1",
        referredUserId: "u2",
        referredDeviceHash: "dev-abc",
        affiliateLastDeviceHash: "dev-abc",
      }),
    ).toBe(true);
  });

  it("flags a matching payment fingerprint", () => {
    expect(
      isSelfReferral({
        affiliateUserId: "u1",
        referredUserId: "u2",
        referredPaymentFingerprint: "card-xyz",
        affiliatePaymentFingerprint: "card-xyz",
      }),
    ).toBe(true);
  });

  it("does not flag an unrelated referral", () => {
    expect(
      isSelfReferral({
        affiliateUserId: "u1",
        referredUserId: "u2",
        referredDeviceHash: "dev-A",
        affiliateLastDeviceHash: "dev-B",
      }),
    ).toBe(false);
  });
});

describe("isBurstSignup", () => {
  it("flags at the threshold, not before", () => {
    expect(isBurstSignup({ signupsFromSameFingerprint: 4 })).toBe(false);
    expect(isBurstSignup({ signupsFromSameFingerprint: 5 })).toBe(true);
  });
});

describe("isRefundRatioExceeded", () => {
  it("flags over 30%, not at or under it", () => {
    expect(isRefundRatioExceeded({ totalReferrals: 10, refundedOrClawedBackReferrals: 3 })).toBe(
      false,
    );
    expect(isRefundRatioExceeded({ totalReferrals: 10, refundedOrClawedBackReferrals: 4 })).toBe(
      true,
    );
  });

  it("never flags with zero referrals", () => {
    expect(isRefundRatioExceeded({ totalReferrals: 0, refundedOrClawedBackReferrals: 0 })).toBe(
      false,
    );
  });
});
