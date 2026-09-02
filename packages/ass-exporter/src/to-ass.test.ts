import { describe, expect, it } from "vitest";

import { makeStyle } from "./testing.js";
import { toAss } from "./to-ass.js";

import type { AssProjection, AssSegment, AssWord } from "./types.js";

const CANVAS = { width: 1080, height: 1920 };

const WORDS: AssWord[] = [
  { wid: "w1", t: "hello", s: 0, e: 300 },
  { wid: "w2", t: "world", s: 300, e: 700 },
];

function segment(overrides: Partial<AssSegment> = {}): AssSegment {
  return {
    id: "seg-1",
    seq: "a0",
    startMs: 0,
    endMs: 700,
    startWordId: "w1",
    endWordId: "w2",
    styleRef: "test-style",
    ...overrides,
  };
}

describe("toAss", () => {
  it("produces a v4.00+ document with PlayRes matching the canvas", () => {
    const projection: AssProjection = { canvas: CANVAS, segments: [segment()] };
    const style = makeStyle();
    const { ass, warnings, stylesUsed } = toAss(projection, WORDS, new Map([[style.id, style]]));
    expect(ass).toContain("ScriptType: v4.00+");
    expect(ass).toContain(`PlayResX: ${String(CANVAS.width)}`);
    expect(ass).toContain(`PlayResY: ${String(CANVAS.height)}`);
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("[Events]");
    expect(ass).toContain("hello world");
    expect(warnings).toEqual([]);
    expect(stylesUsed).toEqual(["test-style"]);
  });

  it("accepts a plain-object style catalogue as well as a Map", () => {
    const projection: AssProjection = { canvas: CANVAS, segments: [segment()] };
    const style = makeStyle();
    const { ass } = toAss(projection, WORDS, { "test-style": style });
    expect(ass).toContain("hello world");
  });

  it("orders segments by seq when present", () => {
    const style = makeStyle();
    const projection: AssProjection = {
      canvas: CANVAS,
      segments: [
        segment({ id: "second", seq: "b0", startWordId: "w2", endWordId: "w2", startMs: 300, endMs: 700 }),
        segment({ id: "first", seq: "a0", startWordId: "w1", endWordId: "w1", startMs: 0, endMs: 300 }),
      ],
    };
    const { ass } = toAss(projection, WORDS, { "test-style": style });
    expect(ass.indexOf("hello")).toBeLessThan(ass.indexOf("world"));
  });

  it("warns and skips a segment whose style cannot be resolved", () => {
    const projection: AssProjection = { canvas: CANVAS, segments: [segment({ styleRef: "missing" })] };
    const { warnings, ass, stylesUsed } = toAss(projection, WORDS, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("effect_only_style");
    expect(stylesUsed).toEqual([]);
    expect(ass).toContain("[Events]");
  });

  it("falls back to opts.defaultStyleId when a segment carries no styleRef", () => {
    const style = makeStyle({ id: "default-style" });
    const projection: AssProjection = { canvas: CANVAS, segments: [segment({ styleRef: undefined })] };
    const { stylesUsed } = toAss(projection, WORDS, { "default-style": style }, CANVAS, {
      defaultStyleId: "default-style",
    });
    expect(stylesUsed).toEqual(["default-style"]);
  });

  it("only emits one Style: line per style even with many segments", () => {
    const style = makeStyle();
    const projection: AssProjection = {
      canvas: CANVAS,
      segments: [segment({ id: "s1" }), segment({ id: "s2", seq: "a1" })],
    };
    const { ass } = toAss(projection, WORDS, { "test-style": style });
    const styleLines = ass.split("\n").filter((line) => line.startsWith("Style: test-style,"));
    expect(styleLines).toHaveLength(1);
  });

  it("defaults the canvas to the projection's own canvas when none is passed", () => {
    const style = makeStyle();
    const projection: AssProjection = { canvas: CANVAS, segments: [segment()] };
    const { ass } = toAss(projection, WORDS, { "test-style": style }, undefined as unknown as typeof CANVAS);
    expect(ass).toContain(`PlayResX: ${String(CANVAS.width)}`);
  });
});
