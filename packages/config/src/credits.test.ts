import { describe, expect, it } from "vitest";

import {
  BILLING_QUANTUM_MS,
  BURN_RATES,
  CREDIT_OPERATIONS,
  creditCostTenths,
  deciMinutes,
  formatCredits,
  quote,
  worstCaseHoldTenths,
} from "./credits.js";

const MINUTE = 60_000;

describe("deciMinutes", () => {
  it("rounds up to the next 0.1 minute", () => {
    expect(deciMinutes(BILLING_QUANTUM_MS)).toBe(1);
    expect(deciMinutes(BILLING_QUANTUM_MS + 1)).toBe(2);
    expect(deciMinutes(MINUTE)).toBe(10);
    expect(deciMinutes(MINUTE + 1)).toBe(11);
  });

  it("never bills less than one quantum", () => {
    expect(deciMinutes(0)).toBe(1);
    expect(deciMinutes(1)).toBe(1);
  });

  it("rejects nonsense durations", () => {
    expect(() => deciMinutes(-1)).toThrow(RangeError);
    expect(() => deciMinutes(Number.NaN)).toThrow(RangeError);
  });
});

describe("creditCostTenths", () => {
  it("charges 1 credit per media minute of transcription", () => {
    expect(creditCostTenths({ operation: "transcription", durationMs: MINUTE })).toBe(10);
    expect(creditCostTenths({ operation: "transcription", durationMs: 10 * MINUTE })).toBe(100);
  });

  it("is free when the work runs locally", () => {
    expect(creditCostTenths({ operation: "transcription", durationMs: MINUTE, local: true })).toBe(
      0,
    );
    expect(creditCostTenths({ operation: "cloudRender", durationMs: MINUTE, local: true })).toBe(0);
  });

  it("charges 0.5 credits per media minute per target language for translation", () => {
    expect(creditCostTenths({ operation: "translation", durationMs: MINUTE })).toBe(5);
    expect(
      creditCostTenths({ operation: "translation", durationMs: MINUTE, targetLanguages: 3 }),
    ).toBe(15);
  });

  it("applies the pro engine rate where one exists", () => {
    expect(creditCostTenths({ operation: "autocutPass", durationMs: MINUTE, tier: "pro" })).toBe(
      20,
    );
    expect(
      creditCostTenths({ operation: "reframeZoomPass", durationMs: MINUTE, tier: "pro" }),
    ).toBe(30);
    // sfxMusicPass has no pro tier, so "pro" falls back to the base rate.
    expect(creditCostTenths({ operation: "sfxMusicPass", durationMs: MINUTE, tier: "pro" })).toBe(
      10,
    );
  });

  it("charges a flat rate for job-basis operations", () => {
    expect(creditCostTenths({ operation: "insightsChapters" })).toBe(20);
    expect(creditCostTenths({ operation: "insightsChapters", durationMs: 99 * MINUTE })).toBe(20);
    expect(creditCostTenths({ operation: "insightsSummary" })).toBe(10);
    expect(creditCostTenths({ operation: "insightsHooks" })).toBe(20);
  });

  it("always returns a non-negative integer number of tenths", () => {
    for (const operation of CREDIT_OPERATIONS) {
      const tenths = creditCostTenths({ operation, durationMs: 12_345 });
      expect(Number.isInteger(tenths)).toBe(true);
      expect(tenths).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("worstCaseHoldTenths", () => {
  it("holds prompted edits on source minutes and settles on finished minutes", () => {
    const hold = worstCaseHoldTenths({
      operation: "promptedEdit",
      sourceDurationMs: 20 * MINUTE,
      durationMs: 2 * MINUTE,
    });
    const settled = creditCostTenths({ operation: "promptedEdit", durationMs: 2 * MINUTE });
    expect(hold).toBe(600);
    expect(settled).toBe(60);
    expect(hold).toBeGreaterThan(settled);
  });

  it("equals the cost for operations with no separate hold basis", () => {
    const input = { operation: "transcription", durationMs: 5 * MINUTE } as const;
    expect(worstCaseHoldTenths(input)).toBe(creditCostTenths(input));
  });
});

describe("BURN_RATES", () => {
  it("covers every operation exactly once", () => {
    expect(CREDIT_OPERATIONS).toHaveLength(11);
    for (const operation of CREDIT_OPERATIONS) {
      expect(BURN_RATES[operation].operation).toBe(operation);
    }
  });
});

describe("quote", () => {
  it("matches creditCostTenths/worstCaseHoldTenths for a simple operation", () => {
    const result = quote("transcription", 5);
    expect(result).toEqual({
      operation: "transcription",
      costTenths: creditCostTenths({ operation: "transcription", durationMs: 5 * MINUTE }),
      holdTenths: worstCaseHoldTenths({ operation: "transcription", durationMs: 5 * MINUTE }),
    });
    expect(result.costTenths).toBe(50);
    expect(result.holdTenths).toBe(50);
  });

  it("holds more than it settles for promptedEdit, from source minutes", () => {
    const result = quote("promptedEdit", 2, { sourceMediaMinutes: 20 });
    expect(result.costTenths).toBe(60);
    expect(result.holdTenths).toBe(600);
    expect(result.holdTenths).toBeGreaterThan(result.costTenths);
  });

  it("defaults sourceMediaMinutes to mediaMinutes when omitted", () => {
    const result = quote("promptedEdit", 5);
    expect(result.holdTenths).toBe(result.costTenths);
  });

  it("passes tier, targetLanguages and local through", () => {
    expect(quote("autocutPass", 10, { tier: "pro" }).costTenths).toBe(200);
    expect(quote("translation", 1, { targetLanguages: 3 }).costTenths).toBe(15);
    expect(quote("transcription", 100, { local: true }).costTenths).toBe(0);
  });

  it("rejects a negative or non-finite mediaMinutes", () => {
    expect(() => quote("transcription", -1)).toThrow(RangeError);
    expect(() => quote("transcription", Number.NaN)).toThrow(RangeError);
  });

  it("never over-charges a duration a caller converted from milliseconds (B02b)", () => {
    // A caller that already has milliseconds (a probed duration, a worker's
    // `outputMs`) divides by 60,000 to call `quote()`. That division can land a
    // few ULPs past an exact `BILLING_QUANTUM_MS` (6,000 ms) boundary — e.g.
    // 498,000 ms / 60,000 * 60,000 = 498,000.00000000006 — which `Math.ceil`
    // would otherwise bill as one whole extra 0.1-minute quantum. Every exact
    // multiple of the quantum up to 100,000 (10,000 minutes) must round-trip
    // to the SAME tenths as calling `creditCostTenths` on the millisecond value
    // directly.
    for (let k = 1; k <= 2_000; k += 1) {
      const ms = k * BILLING_QUANTUM_MS;
      const direct = creditCostTenths({ operation: "cloudRender", durationMs: ms });
      const viaQuote = quote("cloudRender", ms / 60_000).costTenths;
      expect(viaQuote, `k=${String(k)}, ms=${String(ms)}`).toBe(direct);
    }
  });
});

describe("formatCredits", () => {
  it("renders tenths for humans without losing the integer source", () => {
    expect(formatCredits(10)).toBe("1");
    expect(formatCredits(25)).toBe("2.5");
    expect(formatCredits(0)).toBe("0");
  });
});
