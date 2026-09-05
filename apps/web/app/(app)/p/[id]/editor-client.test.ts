import { describe, expect, it } from "vitest";

import { shouldRecordSpellingFix, timelineMenuState } from "./editor-client";

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

/**
 * OC3: the timeline row's right-click menu. The timeline is canvas-drawn, so
 * the menu acts on the selected segment; with nothing selected every row is
 * disabled and a label points at the transcript cards instead. The rows read
 * this rule directly, and for the same reason the predicate above is exported
 * — the editor's own tree is canvas-heavy and belongs to the Playwright lane.
 */
describe("timelineMenuState", () => {
  it("a selected segment enables the menu, with no hint to show", () => {
    expect(timelineMenuState("s1")).toEqual({ disabled: false });
  });

  it("nothing selected disables every row and says where word actions live", () => {
    expect(timelineMenuState(undefined)).toEqual({
      disabled: true,
      hint: "Right-click a transcript card for word-level actions",
    });
  });
});
