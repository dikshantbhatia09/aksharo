import { describe, expect, it } from "vitest";

import { buildSegmentEvents, escapeAssText, wordsFor } from "./events.js";
import { makeStyle } from "./testing.js";

import type { AssWarning } from "./capabilities.js";
import type { AssSegment, AssWord, ToAssOptions } from "./types.js";

const CANVAS = { width: 1080, height: 1920 };

const WORDS: AssWord[] = [
  { wid: "w1", t: "hello", s: 0, e: 300 },
  { wid: "w2", t: "world", s: 300, e: 700 },
  { wid: "w3", t: "देवनागरी", s: 700, e: 1200, scripts: { native: "देवनागरी" } },
];

const SEGMENT: AssSegment = {
  id: "seg-1",
  startMs: 0,
  endMs: 1200,
  startWordId: "w1",
  endWordId: "w3",
};

function opts(extra: Partial<ToAssOptions> = {}): ToAssOptions {
  return { canvas: CANVAS, ...extra };
}

describe("escapeAssText", () => {
  it("escapes braces, backslashes and newlines", () => {
    expect(escapeAssText("a{b}c\\d\ne")).toBe("a\\{b\\}c\\\\d\\Ne");
  });
});

describe("wordsFor", () => {
  it("slices the transcript between startWordId and endWordId inclusive", () => {
    expect(wordsFor(SEGMENT, WORDS, false).map((w) => w.wid)).toEqual(["w1", "w2", "w3"]);
  });

  it("drops fillers when asked", () => {
    const withFiller: AssWord[] = [
      WORDS[0] as AssWord,
      { ...(WORDS[1] as AssWord), filler: true },
      WORDS[2] as AssWord,
    ];
    expect(wordsFor(SEGMENT, withFiller, true).map((w) => w.wid)).toEqual(["w1", "w3"]);
  });

  it("returns nothing when the start word is missing", () => {
    expect(wordsFor({ ...SEGMENT, startWordId: "nope" }, WORDS, false)).toEqual([]);
  });
});

describe("buildSegmentEvents", () => {
  it("returns nothing for a hidden segment", () => {
    const warnings: AssWarning[] = [];
    expect(
      buildSegmentEvents({ ...SEGMENT, hidden: true }, makeStyle(), WORDS, opts(), warnings),
    ).toEqual([]);
  });

  it("emits one plain Dialogue line for a highlight-free style", () => {
    const warnings: AssWarning[] = [];
    const events = buildSegmentEvents(SEGMENT, makeStyle(), WORDS, opts(), warnings);
    expect(events).toHaveLength(1);
    expect(events[0]?.line).toContain("Dialogue: 0,0:00:00.00,0:00:01.20,test-style");
    expect(events[0]?.line).toContain("hello world");
    expect(warnings).toEqual([]);
  });

  it("honours a text override over the transcript words", () => {
    const warnings: AssWarning[] = [];
    const events = buildSegmentEvents(
      { ...SEGMENT, textOverrides: { roman: "custom caption" } },
      makeStyle(),
      WORDS,
      opts(),
      warnings,
    );
    expect(events[0]?.line).toContain("custom caption");
  });

  it("emits \\kf karaoke tags for a Latin karaoke-fill style", () => {
    const warnings: AssWarning[] = [];
    const style = makeStyle({
      animation: {
        in: { type: "none", durationMs: 0 },
        out: { type: "none", durationMs: 0 },
        wordHighlight: { type: "karaoke-fill", durationMs: 0 },
        perWord: false,
      },
    });
    const latinWords = WORDS.slice(0, 2);
    const events = buildSegmentEvents(
      { ...SEGMENT, endWordId: "w2" },
      style,
      latinWords,
      opts(),
      warnings,
    );
    expect(events[0]?.line).toContain("\\kf");
    expect(warnings).toEqual([]);
  });

  it("disables karaoke and warns for non-Latin script, falling back to plain text", () => {
    const warnings: AssWarning[] = [];
    const style = makeStyle({
      animation: {
        in: { type: "none", durationMs: 0 },
        out: { type: "none", durationMs: 0 },
        wordHighlight: { type: "karaoke-fill", durationMs: 0 },
        perWord: false,
      },
    });
    const events = buildSegmentEvents(SEGMENT, style, WORDS, opts(), warnings);
    expect(events[0]?.line).not.toContain("\\kf");
    expect(warnings.some((w) => w.code === "karaoke_non_latin_disabled")).toBe(true);
  });

  it("degrades a color word highlight to one event per word and warns", () => {
    const warnings: AssWarning[] = [];
    const style = makeStyle({
      colors: { text: "#ffffff", activeText: "#ff0000", upcomingText: "#ffffff66" },
      animation: {
        in: { type: "none", durationMs: 0 },
        out: { type: "none", durationMs: 0 },
        wordHighlight: { type: "color", durationMs: 0 },
        perWord: false,
      },
    });
    const events = buildSegmentEvents(SEGMENT, style, WORDS, opts(), warnings);
    expect(events).toHaveLength(3);
    expect(warnings.some((w) => w.code === "word_highlight_per_word_events")).toBe(true);
  });

  it("degrades a scale word highlight with \\fscx/\\fscy per word", () => {
    const warnings: AssWarning[] = [];
    const style = makeStyle({
      animation: {
        in: { type: "none", durationMs: 0 },
        out: { type: "none", durationMs: 0 },
        wordHighlight: { type: "scale", durationMs: 0, scale: 1.3 },
        perWord: false,
      },
    });
    const events = buildSegmentEvents(SEGMENT, style, WORDS, opts(), warnings);
    expect(events.some((e) => e.line.includes("\\fscx130"))).toBe(true);
  });

  it("degrades an underline word highlight with \\u1 per word", () => {
    const warnings: AssWarning[] = [];
    const style = makeStyle({
      animation: {
        in: { type: "none", durationMs: 0 },
        out: { type: "none", durationMs: 0 },
        wordHighlight: { type: "underline", durationMs: 0 },
        perWord: false,
      },
    });
    const events = buildSegmentEvents(SEGMENT, style, WORDS, opts(), warnings);
    expect(events.some((e) => e.line.includes("\\u1"))).toBe(true);
  });

  it("degrades a glow word highlight to outline+blur and warns glow_reduced_to_outline", () => {
    const warnings: AssWarning[] = [];
    const style = makeStyle({
      animation: {
        in: { type: "none", durationMs: 0 },
        out: { type: "none", durationMs: 0 },
        wordHighlight: { type: "glow", durationMs: 0 },
        perWord: false,
      },
    });
    const events = buildSegmentEvents(SEGMENT, style, WORDS, opts(), warnings);
    expect(events.some((e) => e.line.includes("\\be1"))).toBe(true);
    expect(warnings.some((w) => w.code === "glow_reduced_to_outline")).toBe(true);
  });

  it("splits an event at a cut when a timemap is supplied", () => {
    const warnings: AssWarning[] = [];
    const timemap = {
      mapRange: () => [
        { outputStart: 0, outputEnd: 300 },
        { outputStart: 300, outputEnd: 900 },
      ],
    } as unknown as ToAssOptions["timemap"];
    const events = buildSegmentEvents(SEGMENT, makeStyle(), WORDS, opts({ timemap }), warnings);
    expect(events).toHaveLength(2);
  });

  it("resolves the native script text when script: 'native' is requested", () => {
    const warnings: AssWarning[] = [];
    const events = buildSegmentEvents(
      SEGMENT,
      makeStyle(),
      WORDS,
      opts({ script: "native" }),
      warnings,
    );
    expect(events[0]?.line).toContain("देवनागरी");
  });

  it("returns nothing when the segment has no visible words", () => {
    const warnings: AssWarning[] = [];
    expect(
      buildSegmentEvents(
        { ...SEGMENT, startWordId: "missing" },
        makeStyle(),
        WORDS,
        opts(),
        warnings,
      ),
    ).toEqual([]);
  });
});
