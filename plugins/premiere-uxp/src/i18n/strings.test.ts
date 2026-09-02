import { describe, expect, it } from "vitest";

import { LANGUAGE_HINTS, t } from "./strings.js";

describe("t()", () => {
  it("returns the English string by default", () => {
    expect(t("signIn.title")).toBe("Sign in");
  });

  it("returns the Hindi string when asked", () => {
    expect(t("signIn.title", {}, "hi")).toBe("साइन इन करें");
  });

  it("interpolates placeholders", () => {
    expect(t("status.uploading", { percent: 42 })).toBe("Uploading audio… 42%");
  });

  it("leaves an unmatched placeholder untouched", () => {
    expect(t("status.uploading", {})).toBe("Uploading audio… {percent}%");
  });

  it("has a Hinglish-first language hint list (08 §Onboarding)", () => {
    expect(LANGUAGE_HINTS[0]).toEqual({ code: "hi-Latn", label: "Hinglish (Roman)" });
  });

  it("carries the D65 non-affiliation copy in both locales", () => {
    expect(t("footer.nonAffiliation")).toMatch(/not affiliated with or endorsed by Adobe/);
    expect(t("footer.nonAffiliation", {}, "hi")).toMatch(/Adobe से संबद्ध/);
  });
});
