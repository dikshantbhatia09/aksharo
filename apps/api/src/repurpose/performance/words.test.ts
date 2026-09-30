import { describe, expect, it } from "vitest";

import { contentWords, hookStyle } from "./words.js";

/**
 * The same examples as the worker's `tests/test_highlights_performance.py`:
 * what this side finds did best is what that side lifts, so the two must read
 * a hook and a title the same way.
 */
describe("contentWords", () => {
  it("keeps content words in every script, as the worker does", () => {
    expect(contentWords("My grandfather's cricket bat")).toEqual(
      new Set(["grandfather", "cricket"]),
    );
    expect(contentWords("Savings: 90 tips that REALLY work")).toEqual(
      new Set(["saving", "tips", "work"]),
    );
    expect(contentWords("Salary aate hi ye galti mat karna")).toEqual(
      new Set(["salary", "aate", "galti"]),
    );
    expect(contentWords("पैसा बचाने के तरीके")).toEqual(new Set(["पैसा", "बचाने", "तरीके"]));
  });
});

describe("hookStyle", () => {
  it.each([
    ["Did you know that 90 percent of people never check this?", "question"],
    ["Kya aapko pata hai ki ye galti sab karte hain", "question"],
    ["क्या आप जानते हैं", "question"],
    ["Why nobody tells you this", "question"],
    ["90 percent of people never check this", "number"],
    ["Three things I wish I knew", "number"],
    ["You are doing this wrong", "you"],
    ["Aap ye galti karte ho", "you"],
    ["The market fell today", "statement"],
    ["", "statement"],
  ])("reads %j as %s, as the worker does", (text, style) => {
    expect(hookStyle(text)).toBe(style);
  });
});
