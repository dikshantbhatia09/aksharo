import { describe, expect, it } from "vitest";

import { defaultQuickPickLanguage } from "./quick-pick-row";

/**
 * FIX-04 rewrote this contract. The three cases below used to assert a
 * `"hi-Latn"` fallback — that assertion *was* the audit's defect written down:
 * it made "we were never told" indistinguishable from "the user chose
 * Hinglish", and the credits were then spent on the difference.
 */
describe("defaultQuickPickLanguage", () => {
  it("uses the caller's first onboarding language when it is one we offer", () => {
    expect(defaultQuickPickLanguage(["ta", "en"])).toBe("ta");
  });

  it("answers undefined — never Hinglish — when onboarding recorded nothing", () => {
    expect(defaultQuickPickLanguage(undefined)).toBeUndefined();
    expect(defaultQuickPickLanguage([])).toBeUndefined();
  });

  it("answers undefined when the saved language is not one of the quick-pick options", () => {
    expect(defaultQuickPickLanguage(["fr"])).toBeUndefined();
  });
});
