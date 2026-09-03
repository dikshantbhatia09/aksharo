import { describe, expect, it } from "vitest";

import { countUpText, formatLocaleNumber } from "./count.js";

describe("countUpText", () => {
  it("counts from 0 at fraction 0", () => {
    expect(countUpText("50,000 creators", 0, "latin")).toBe("0 creators");
  });

  it("counts to the full number at fraction 1", () => {
    expect(countUpText("50,000 creators", 1, undefined)).toBe("50,000 creators");
  });

  it("counts partway at a mid fraction, preserving grouping", () => {
    expect(countUpText("50,000 creators", 0.5, undefined)).toBe("25,000 creators");
  });

  it("leaves text with no number unchanged", () => {
    expect(countUpText("no numbers here", 0.5, undefined)).toBe("no numbers here");
  });

  it("does not add grouping the source text did not use", () => {
    expect(countUpText("1200 views", 0.5, undefined)).toBe("600 views");
  });

  it("clamps a fraction outside [0,1]", () => {
    expect(countUpText("100 users", -1, undefined)).toBe("0 users");
    expect(countUpText("100 users", 2, undefined)).toBe("100 users");
  });

  it("formats Devanagari digits for a Hindi/Marathi title", () => {
    const result = formatLocaleNumber(50, "devanagari", false);
    expect(result).not.toBe("50");
    expect(result).toBe(new Intl.NumberFormat("hi-u-nu-deva", { useGrouping: false }).format(50));
  });

  it("formats Tamil digits for a Tamil title", () => {
    const result = formatLocaleNumber(50, "tamil", false);
    expect(result).toBe(
      new Intl.NumberFormat("ta-u-nu-tamldec", { useGrouping: false }).format(50),
    );
  });

  it("substitutes Devanagari digits into a mixed-script title", () => {
    const result = countUpText("५0 creators".replace("५", "5"), 1, "devanagari");
    expect(result.endsWith(" creators")).toBe(true);
    expect(result).not.toContain("50");
  });
});
