import { describe, expect, it } from "vitest";

import { createExchangeRateProvider, ManualFallbackExchangeRateProvider } from "./exchange-rate.js";

describe("ManualFallbackExchangeRateProvider", () => {
  const provider = new ManualFallbackExchangeRateProvider([
    { effectiveFrom: new Date("2025-01-01T00:00:00.000Z"), rate: 85 },
    { effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), rate: 87 },
  ]);

  it("picks the latest rate on or before the requested date", async () => {
    const quote = await provider.getUsdToInrRate(new Date("2026-06-01T00:00:00.000Z"));
    expect(quote).toMatchObject({ rate: 87, source: "manual_table" });
  });

  it("falls back to the earliest entry for a date before the table starts", async () => {
    const quote = await provider.getUsdToInrRate(new Date("2020-01-01T00:00:00.000Z"));
    expect(quote.rate).toBe(85);
  });

  it("is unaffected by table entry order", async () => {
    const unordered = new ManualFallbackExchangeRateProvider([
      { effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), rate: 87 },
      { effectiveFrom: new Date("2025-01-01T00:00:00.000Z"), rate: 85 },
    ]);
    const quote = await unordered.getUsdToInrRate(new Date("2025-06-01T00:00:00.000Z"));
    expect(quote.rate).toBe(85);
  });
});

describe("createExchangeRateProvider", () => {
  it("returns the manual fallback (no live RBI feed configured in this environment)", async () => {
    const provider = createExchangeRateProvider();
    const quote = await provider.getUsdToInrRate(new Date());
    expect(quote.source).toBe("manual_table");
    expect(quote.rate).toBeGreaterThan(0);
  });
});
