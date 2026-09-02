import { describe, expect, it } from "vitest";

import type { Word } from "@montaj/edg";

import { findMatches, findSameSpelling, replaceAll } from "./find-replace";

function word(wid: string, t: string, extra: Partial<Word> = {}): Word {
  return { wid: wid as never, s: 0, e: 100, t, ...extra };
}

const WORDS: Word[] = [
  word("0:0", "Hello"),
  word("0:1", "hello"),
  word("0:2", "world"),
  word("0:3", "helloed"),
  word("0:4", "gone", { deleted: true }),
  word("0:5", "namaste", { scripts: { roman: "namaste", native: "नमस्ते" } }),
];

describe("findMatches", () => {
  it("matches case-insensitively and substring by default", () => {
    const matches = findMatches(WORDS, "hello", "roman");
    expect(matches.map((m) => m.wordId)).toEqual(["0:0", "0:1", "0:3"]);
  });

  it("case-sensitive narrows to exact casing", () => {
    const matches = findMatches(WORDS, "Hello", "roman", { caseSensitive: true });
    expect(matches.map((m) => m.wordId)).toEqual(["0:0"]);
  });

  it("whole-word excludes partial matches like 'helloed'", () => {
    const matches = findMatches(WORDS, "hello", "roman", { wholeWord: true });
    expect(matches.map((m) => m.wordId)).toEqual(["0:0", "0:1"]);
  });

  it("skips deleted (tombstoned) words", () => {
    const matches = findMatches(WORDS, "gone", "roman");
    expect(matches).toEqual([]);
  });

  it("reads the requested display script", () => {
    const matches = findMatches(WORDS, "नमस्ते", "native");
    expect(matches.map((m) => m.wordId)).toEqual(["0:5"]);
  });

  it("regex mode matches a pattern, and an invalid pattern yields no matches", () => {
    expect(findMatches(WORDS, "^hello", "roman", { regex: true }).map((m) => m.wordId)).toEqual([
      "0:0",
      "0:1",
      "0:3",
    ]);
    expect(findMatches(WORDS, "(", "roman", { regex: true })).toEqual([]);
  });

  it("an empty query matches nothing", () => {
    expect(findMatches(WORDS, "", "roman")).toEqual([]);
  });
});

describe("replaceAll", () => {
  it("sets every match's replacement to the same text", () => {
    const matches = findMatches(WORDS, "hello", "roman", { wholeWord: true });
    const replaced = replaceAll(matches, "hi");
    expect(replaced.every((m) => m.replacement === "hi")).toBe(true);
    expect(replaced).toHaveLength(2);
  });
});

describe("findSameSpelling", () => {
  it("is case-sensitive and whole-word — 'Fix spelling everywhere' on 'hello' does not touch 'Hello'", () => {
    const matches = findSameSpelling(WORDS, "hello", "roman");
    expect(matches.map((m) => m.wordId)).toEqual(["0:1"]);
  });
});
