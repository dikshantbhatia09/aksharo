import { describe, expect, it } from "vitest";

import { BURN_RATES } from "@montaj/config";

import { quoteAudioClean, settlementFor } from "./audio.quote.js";

describe("the audio-clean quote", () => {
  it("charges the CONTRACTS §4 rate from packages/config, not a number of its own", () => {
    expect(BURN_RATES.audioClean.ratePerUnitTenths).toBe(10);
    // One minute at 1 credit a minute.
    expect(quoteAudioClean(60_000).tenths).toBe(10);
  });

  it("rounds media time up to the 0.1-minute billing quantum", () => {
    expect(quoteAudioClean(6_100).deciMinutes).toBe(2);
    expect(quoteAudioClean(12_000).deciMinutes).toBe(2);
    expect(quoteAudioClean(1).deciMinutes).toBe(1);
  });

  it("never quotes zero for media that exists", () => {
    expect(quoteAudioClean(1).tenths).toBeGreaterThan(0);
  });

  it("quotes a 60-minute recording at 60 credits", () => {
    const quote = quoteAudioClean(60 * 60_000);
    expect(quote.tenths).toBe(600);
    expect(quote.credits).toBe("60");
  });

  it("explains itself in the hold's audit trail", () => {
    expect(quoteAudioClean(90_000).reason).toBe("ai.clean · 1.5 media minutes");
  });

  it("refuses to quote media whose duration is unknown", () => {
    expect(() => quoteAudioClean(Number.NaN)).toThrow(RangeError);
    expect(() => quoteAudioClean(-1)).toThrow(RangeError);
  });

  describe("settlement", () => {
    const quote = quoteAudioClean(600_000); // 10 minutes, 100 tenths

    it("settles the full hold when the worker reports nothing", () => {
      expect(settlementFor(quote)).toBe(quote.tenths);
      expect(settlementFor(quote, Number.NaN)).toBe(quote.tenths);
      expect(settlementFor(quote, -5)).toBe(quote.tenths);
    });

    it("settles less when the worker decoded less than was held", () => {
      expect(settlementFor(quote, 300)).toBe(50);
    });

    it("never settles more than was held", () => {
      expect(settlementFor(quote, 3_600)).toBe(quote.tenths);
    });
  });
});
