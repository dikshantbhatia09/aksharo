import { describe, expect, it } from "vitest";

import { BURN_RATES } from "@montaj/config";

import { quoteTranscription, settlementFor } from "./transcripts.quote.js";

describe("the transcription quote", () => {
  it("charges the CONTRACTS §4 rate from packages/config, not a number of its own", () => {
    expect(BURN_RATES.transcription.ratePerUnitTenths).toBe(10);
    // One minute at 1 credit a minute.
    expect(quoteTranscription(60_000).tenths).toBe(10);
  });

  it("rounds media time up to the 0.1-minute billing quantum", () => {
    // 6.1 s is two deciminutes; 12 s is exactly two.
    expect(quoteTranscription(6_100).deciMinutes).toBe(2);
    expect(quoteTranscription(12_000).deciMinutes).toBe(2);
    expect(quoteTranscription(1).deciMinutes).toBe(1);
  });

  it("never quotes zero for media that exists", () => {
    expect(quoteTranscription(1).tenths).toBeGreaterThan(0);
  });

  it("quotes a 60-minute recording at 60 credits", () => {
    const quote = quoteTranscription(60 * 60_000);
    expect(quote.tenths).toBe(600);
    expect(quote.credits).toBe("60");
  });

  it("explains itself in the hold's audit trail", () => {
    expect(quoteTranscription(90_000).reason).toBe("ai.transcribe · 1.5 media minutes");
  });

  it("refuses to quote media whose duration is unknown", () => {
    expect(() => quoteTranscription(Number.NaN)).toThrow(RangeError);
    expect(() => quoteTranscription(-1)).toThrow(RangeError);
  });

  describe("settlement", () => {
    const quote = quoteTranscription(600_000); // 10 minutes, 100 tenths

    it("settles the full hold when the worker reports nothing", () => {
      expect(settlementFor(quote)).toBe(quote.tenths);
      expect(settlementFor(quote, Number.NaN)).toBe(quote.tenths);
      expect(settlementFor(quote, -5)).toBe(quote.tenths);
    });

    it("settles less when the worker decoded less than was held", () => {
      expect(settlementFor(quote, 300)).toBe(50);
    });

    it("never settles more than was held", () => {
      // A worker claiming an hour against a ten-minute hold is a bug, not a bill.
      expect(settlementFor(quote, 3_600)).toBe(quote.tenths);
    });
  });
});
