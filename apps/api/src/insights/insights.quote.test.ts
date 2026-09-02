import { describe, expect, it } from "vitest";

import { TENTHS_PER_CREDIT } from "@montaj/config";

import { INSIGHT_KIND_TENTHS, quoteInsight, quoteInsightBatch } from "./insights.quote.js";

describe("the insights quote (brief §4: chapters 2, summary 1, hooks 2)", () => {
  it("prices chapters at 2 credits", () => {
    expect(quoteInsight("chapters").tenths).toBe(2 * TENTHS_PER_CREDIT);
    expect(quoteInsight("chapters").credits).toBe("2");
  });

  it("prices summary at 1 credit", () => {
    expect(quoteInsight("summary").tenths).toBe(1 * TENTHS_PER_CREDIT);
    expect(quoteInsight("summary").credits).toBe("1");
  });

  it("prices hooks at 2 credits", () => {
    expect(quoteInsight("hooks").tenths).toBe(2 * TENTHS_PER_CREDIT);
  });

  it("names the queue and kind in the hold's audit trail", () => {
    expect(quoteInsight("summary").reason).toBe("ai.llm · summary");
  });

  it("sums a batch of kinds", () => {
    expect(quoteInsightBatch(["chapters", "summary", "hooks"])).toBe(
      INSIGHT_KIND_TENTHS.chapters + INSIGHT_KIND_TENTHS.summary + INSIGHT_KIND_TENTHS.hooks,
    );
    expect(quoteInsightBatch(["summary"])).toBe(INSIGHT_KIND_TENTHS.summary);
    expect(quoteInsightBatch([])).toBe(0);
  });
});
