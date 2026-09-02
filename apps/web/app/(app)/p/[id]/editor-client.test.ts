import { describe, expect, it } from "vitest";

import { shouldRecordSpellingFix } from "./editor-client";

/**
 * B09b: `onFixSpellingEverywhere`'s decision to post
 * `POST /memory/hooks/spelling-fix` — consent-gated, and never for a "fix"
 * that changes nothing. The full component is canvas-heavy and covered by
 * the Playwright lane (see `editor-client.tsx`'s doc-comment and
 * `Timeline.tsx`'s precedent), so this predicate is exported and tested in
 * isolation rather than through a jsdom render of the whole editor.
 */
describe("shouldRecordSpellingFix", () => {
  it("consent off: never records, even for a real spelling change", () => {
    expect(shouldRecordSpellingFix(false, "achsharo", "Aksharo")).toBe(false);
  });

  it("consent on: records a genuine change", () => {
    expect(shouldRecordSpellingFix(true, "achsharo", "Aksharo")).toBe(true);
  });

  it("consent on, but nothing actually changed: does not record", () => {
    expect(shouldRecordSpellingFix(true, "Aksharo", "Aksharo")).toBe(false);
  });

  it("no original word found (undefined): does not record", () => {
    expect(shouldRecordSpellingFix(true, undefined, "Aksharo")).toBe(false);
  });

  it("an original word that is only whitespace: does not record", () => {
    expect(shouldRecordSpellingFix(true, "   ", "Aksharo")).toBe(false);
  });
});
