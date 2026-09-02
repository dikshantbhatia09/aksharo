import { describe, expect, it } from "vitest";

import { BURN_RATES } from "@montaj/config";

import { quoteAutocut } from "./passes.quote.js";

describe("the autocut pass quote", () => {
  it("charges the CONTRACTS §4 rate from packages/config, not a number of its own", () => {
    expect(BURN_RATES.autocutPass.ratePerUnitTenths).toBe(10);
    expect(BURN_RATES.autocutPass.basis).toBe("sourceMinute");
    // One minute at the flash rate (1 credit/minute).
    expect(quoteAutocut(60_000).tenths).toBe(10);
  });

  it("rounds source time up to the 0.1-minute billing quantum", () => {
    expect(quoteAutocut(6_100).deciMinutes).toBe(2);
    expect(quoteAutocut(12_000).deciMinutes).toBe(2);
    expect(quoteAutocut(1).deciMinutes).toBe(1);
  });

  it("never quotes zero for media that exists", () => {
    expect(quoteAutocut(1).tenths).toBeGreaterThan(0);
  });

  it("quotes a 90-second recording at 1.5 credits (flash)", () => {
    const quote = quoteAutocut(90_000);
    expect(quote.tenths).toBe(15);
    expect(quote.credits).toBe("1.5");
  });

  it("explains itself in the hold's audit trail", () => {
    expect(quoteAutocut(90_000).reason).toBe("ai.pass (autocut) · 1.5 source minutes");
  });
});
