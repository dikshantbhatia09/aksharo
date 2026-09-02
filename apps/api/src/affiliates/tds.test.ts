import { describe, expect, it } from "vitest";

import {
  computeTds,
  TDS_RATE_WITHOUT_PAN_BPS,
  TDS_RATE_WITH_PAN_BPS,
  TDS_THRESHOLD_MINOR,
} from "./tds.js";

describe("computeTds — crossing ₹20,000 mid-year (brief §4)", () => {
  it("deducts nothing while the running FY total stays under the threshold", () => {
    const result = computeTds({
      priorFyGrossMinor: 500_000,
      grossMinor: 500_000,
      hasVerifiedPan: true,
    });
    expect(result.newFyGrossMinor).toBe(1_000_000);
    expect(result.tdsAmountMinor).toBe(0);
    expect(result.netPayableMinor).toBe(500_000);
    expect(result.crossedThresholdOnThisCommission).toBe(false);
  });

  it("taxes the whole commission that crosses the ₹20,000 line, at 2% with a verified PAN", () => {
    const result = computeTds({
      priorFyGrossMinor: TDS_THRESHOLD_MINOR - 100_000, // ₹19,000 so far
      grossMinor: 200_000, // ₹2,000 more -> ₹21,000 total
      hasVerifiedPan: true,
    });
    expect(result.crossedThresholdOnThisCommission).toBe(true);
    expect(result.tdsRateBps).toBe(TDS_RATE_WITH_PAN_BPS);
    expect(result.tdsAmountMinor).toBe(4_000); // 2% of ₹2,000
    expect(result.netPayableMinor).toBe(196_000);
  });

  it("taxes at 20% without a verified PAN", () => {
    const result = computeTds({
      priorFyGrossMinor: TDS_THRESHOLD_MINOR - 100_000,
      grossMinor: 200_000,
      hasVerifiedPan: false,
    });
    expect(result.tdsRateBps).toBe(TDS_RATE_WITHOUT_PAN_BPS);
    expect(result.tdsAmountMinor).toBe(40_000); // 20% of ₹2,000
    expect(result.netPayableMinor).toBe(160_000);
  });

  it("keeps taxing every later commission in the same FY, not just the one that crossed", () => {
    const result = computeTds({
      priorFyGrossMinor: TDS_THRESHOLD_MINOR + 500_000, // already well over
      grossMinor: 300_000,
      hasVerifiedPan: true,
    });
    expect(result.tdsAmountMinor).toBe(6_000);
    expect(result.crossedThresholdOnThisCommission).toBe(false); // already crossed earlier
  });

  it("exactly at the threshold is taxed (>= not >)", () => {
    const result = computeTds({
      priorFyGrossMinor: 0,
      grossMinor: TDS_THRESHOLD_MINOR,
      hasVerifiedPan: true,
    });
    expect(result.tdsAmountMinor).toBeGreaterThan(0);
    expect(result.crossedThresholdOnThisCommission).toBe(true);
  });
});
