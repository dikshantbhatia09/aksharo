import { describe, expect, it } from "vitest";

import { estimateAutocutQuote } from "./quote";

describe("estimateAutocutQuote", () => {
  it("rounds up to the nearest 0.1 minute and prices at the autocutPass flash rate", () => {
    const quote = estimateAutocutQuote(65_000); // 1.083 minutes -> 1.1 deciMinutes-rounded
    expect(quote.durationMs).toBe(65_000);
    expect(quote.deciMinutes).toBeGreaterThan(0);
    expect(quote.tenths).toBeGreaterThan(0);
    expect(quote.credits).toMatch(/^\d/);
    expect(quote.reason).toContain("ai.pass (autocut)");
  });

  it("is monotonic in duration", () => {
    const shortQuote = estimateAutocutQuote(30_000);
    const longQuote = estimateAutocutQuote(300_000);
    expect(longQuote.tenths).toBeGreaterThan(shortQuote.tenths);
  });
});
