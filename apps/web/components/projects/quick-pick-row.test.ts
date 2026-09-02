import { describe, expect, it } from "vitest";

import { defaultQuickPickLanguage } from "./quick-pick-row";

describe("defaultQuickPickLanguage", () => {
  it("uses the caller's first onboarding language when it is one we offer", () => {
    expect(defaultQuickPickLanguage(["ta", "en"])).toBe("ta");
  });

  it("falls back to Hinglish (Roman) when there is no onboarding language", () => {
    expect(defaultQuickPickLanguage(undefined)).toBe("hi-Latn");
    expect(defaultQuickPickLanguage([])).toBe("hi-Latn");
  });

  it("falls back when the saved language is not one of the quick-pick options", () => {
    expect(defaultQuickPickLanguage(["fr"])).toBe("hi-Latn");
  });
});
