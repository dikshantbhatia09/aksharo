import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap, type StyleDoc } from "@montaj/caption-styles";

import { rectHeight, rectWidth } from "../commands/build.js";
import { RenderError } from "../errors.js";
import { createFontRegistry } from "../fonts/registry.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { charCount } from "../script.js";
import {
  CAPTION_FIXTURES,
  createFixtureRenderer,
  GOLDEN_CANVAS,
  PROXY_CANVAS,
} from "../testing.js";
import { itemise, splitByScript } from "./itemise.js";
import {
  applyTextTransform,
  assertLayoutable,
  captionCharacterCount,
  layoutSegment,
  MIN_SHRINK,
  visibleWords,
  __testing,
} from "./layout.js";
import { type Layout, type RenderWord } from "./types.js";
import {
  balanceIntoLines,
  breakWordAtClusters,
  toWrapItems,
  wrapByCharacters,
  wrapByWidth,
} from "./wrap.js";

const styles = loadSystemStyleMap();
let registry: FontRegistry;
let shaper: Shaper;

beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
});

function style(id: string, overrides: Partial<StyleDoc> = {}): StyleDoc {
  const base = styles.get(id);
  if (base === undefined) throw new Error(`no style ${id}`);
  return { ...base, ...overrides };
}

function words(texts: readonly string[], startMs = 0, endMs = 3000): RenderWord[] {
  const span = endMs - startMs;
  return texts.map((t, index) => ({
    wid: `0:${String(index)}`,
    t,
    s: startMs + Math.round((span * index) / texts.length),
    e: startMs + Math.round((span * (index + 1)) / texts.length),
  }));
}

function lay(
  styleDoc: StyleDoc,
  list: readonly RenderWord[],
  tMs = 1500,
  canvas = GOLDEN_CANVAS,
): Layout {
  return layoutSegment({
    style: styleDoc,
    segment: { id: "seg", startMs: 0, endMs: 3000 },
    words: list,
    canvas,
    registry,
    shaper,
    tMs,
  });
}

describe("text transforms", () => {
  it.each([
    ["uppercase", "hello world", "HELLO WORLD"],
    ["lowercase", "HELLO", "hello"],
    ["capitalize", "hello big world", "Hello Big World"],
    ["none", "hello", "hello"],
  ] as const)("%s", (transform, input, expected) => {
    expect(applyTextTransform(input, transform)).toBe(expected);
  });
});

describe("script itemisation", () => {
  it("splits a Hinglish word at the script boundary and keeps neutrals left", () => {
    expect(splitByScript("video के", "latin").map((run) => run.text)).toEqual(["video ", "के"]);
    expect(splitByScript("₹499,", "latin").map((run) => run.text)).toEqual(["₹499,"]);
    expect(splitByScript("", "latin")).toEqual([]);
  });

  it("resolves a face per run and merges neighbours that share one", () => {
    const runs = itemise("video के बारे", registry, {
      family: "Inter",
      fallbacks: ["Noto Sans Devanagari"],
      weight: 700,
      italic: false,
      defaultScript: "latin",
    });
    expect(runs).toHaveLength(2);
    expect(runs[0]?.script).toBe("latin");
    expect(runs[1]?.script).toBe("devanagari");
    expect(runs[1]?.fontId).toContain("devanagari");
  });

  it("raises render/no-font when nothing can draw a run", () => {
    const bare = createFontRegistry();
    expect(() =>
      itemise("abc", bare, { family: "Inter", weight: 400, italic: false, defaultScript: "latin" }),
    ).toThrow(RenderError);
  });
});

describe("wrapping", () => {
  it("reproduces the segmenter's greedy character wrap", () => {
    // "Bhai aaj hum baat karenge video" is 31 characters, so "editing" is the
    // first word that does not fit the Latin budget of 32.
    const items = toWrapItems(["Bhai", "aaj", "hum", "baat", "karenge", "video", "editing"]);
    expect(wrapByCharacters(items, 32)).toEqual([[0, 1, 2, 3, 4, 5], [6]]);
    expect(wrapByCharacters(items, 20)).toEqual([[0, 1, 2, 3], [4, 5], [6]]);
    expect(wrapByCharacters([], 32)).toEqual([]);
  });

  it("counts characters the way the segmenter does — marks excluded", () => {
    // ह + ि + ं + द + ी is five code points but two base characters.
    expect(charCount("हिंदी")).toBe(2);
    expect(toWrapItems(["हिंदी"])[0]?.chars).toBe(2);
    expect(charCount("hindi")).toBe(5);
  });

  it("balances into exactly maxLines when the character wrap asks for more", () => {
    const items = toWrapItems(["one", "two", "three", "four", "five", "six"]);
    expect(balanceIntoLines(items, 2)).toHaveLength(2);
    expect(balanceIntoLines(items, 1)).toEqual([[0, 1, 2, 3, 4, 5]]);
    expect(balanceIntoLines([], 2)).toEqual([]);
  });

  it("never leaves a balanced line empty", () => {
    expect(balanceIntoLines(toWrapItems(["a", "b"]), 4).every((line) => line.length > 0)).toBe(
      true,
    );
    expect(balanceIntoLines(toWrapItems(["a", "b"]), 4)).toHaveLength(2);
  });

  it("wraps by measured width when asked", () => {
    const items = toWrapItems(["a", "b", "c"]);
    expect(wrapByWidth(items, () => 40, 10, 100)).toEqual([[0, 1], [2]]);
    expect(wrapByWidth([], () => 1, 1, 1)).toEqual([]);
  });

  it("breaks a long word only on cluster boundaries", () => {
    const clusters = [0, 2, 4, 6];
    const pieces = breakWordAtClusters("abcdef", clusters, (cluster) => cluster * 10, 25);
    expect(pieces.join("")).toBe("abcdef");
    expect(pieces.length).toBeGreaterThan(1);
    expect(breakWordAtClusters("abc", [0], () => 0, 10)).toEqual(["abc"]);
    expect(breakWordAtClusters("abc", [0, 1], () => 0, 0)).toEqual(["abc"]);
  });
});

describe("visible words", () => {
  const list = words(["one", "two", "three", "four", "five", "six"]);

  it("shows the whole caption by default", () => {
    expect(visibleWords(list, style("karaoke-fill"), 100)).toHaveLength(6);
  });

  it("shows one word at a time for a per-word style", () => {
    const perWord = style("word-pop", {
      animation: { ...style("word-pop").animation, perWord: true },
    });
    expect(visibleWords(list, perWord, 100)).toHaveLength(1);
    expect(visibleWords(list, perWord, 2900)?.[0]?.t).toBe("six");
  });

  it("shows one chunk at a time when the style sets wordsPerCue", () => {
    const chunked = style("punch-pop");
    expect(chunked.layout.wordsPerCue).toBe(4);
    expect(visibleWords(list, chunked, 100).map((word) => word.t)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
    expect(visibleWords(list, chunked, 2900).map((word) => word.t)).toEqual(["five", "six"]);
  });

  it("returns an empty caption unchanged", () => {
    expect(visibleWords([], style("punch-pop"), 0)).toEqual([]);
  });

  it("clamps the index outside the caption's own span", () => {
    expect(__testing.indexAt(list, -500)).toBe(0);
    expect(__testing.indexAt(list, 999_999)).toBe(5);
  });
});

describe("layoutSegment", () => {
  it("lays every fixture out inside the style's box", () => {
    for (const fixture of CAPTION_FIXTURES) {
      const doc = style("vertical-clean");
      const layout = lay(doc, fixture.words);
      const maxWidth = (doc.layout.maxWidthPct / 100) * GOLDEN_CANVAS.width;
      expect(rectWidth(layout.box), fixture.name).toBeLessThanOrEqual(maxWidth + 0.5);
      expect(layout.lines.length, fixture.name).toBeLessThanOrEqual(doc.layout.maxLines);
      expect(layout.words.length, fixture.name).toBeGreaterThan(0);
    }
  });

  it("detects the script of the caption it is actually drawing", () => {
    expect(lay(style("vertical-clean"), words(["देखो", "पहले"])).script).toBe("devanagari");
    expect(lay(style("vertical-clean"), words(["இன்று", "நாம்"])).script).toBe("tamil");
    expect(lay(style("vertical-clean"), words(["hello", "there"])).script).toBe("latin");
  });

  it("honours a forced script and a forced character budget", () => {
    const layout = layoutSegment({
      style: style("vertical-clean"),
      segment: { id: "seg", startMs: 0, endMs: 3000 },
      words: words(["aaa", "bbb", "ccc", "ddd"]),
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      tMs: 0,
      script: "latin",
      maxChars: 7,
    });
    expect(layout.lines).toHaveLength(2);
  });

  it("keeps the segmenter's split when the metrics fit", () => {
    const doc = style("vertical-clean");
    const list = words(["Bhai", "aaj", "hum", "baat"]);
    const layout = lay(doc, list);
    expect(layout.shrink).toBe(1);
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]?.text).toBe("Bhai aaj hum baat");
  });

  it("shrinks rather than re-wrapping when the metrics overflow", () => {
    const doc = style("vertical-clean", {
      typography: { ...style("vertical-clean").typography, sizePct: 12 },
    });
    const layout = lay(doc, words(["Bhai", "aaj", "hum", "baat"]));
    expect(layout.shrink).toBeLessThan(1);
    expect(layout.shrink).toBeGreaterThanOrEqual(MIN_SHRINK);
    expect(layout.fontSizePx).toBeLessThan((12 / 100) * GOLDEN_CANVAS.height);
  });

  it("never shrinks past the floor, re-wrapping by width instead", () => {
    const doc = style("vertical-clean", {
      typography: { ...style("vertical-clean").typography, sizePct: 20 },
      layout: { ...style("vertical-clean").layout, maxLines: 4, maxWidthPct: 40 },
    });
    const layout = lay(doc, words(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]));
    expect(layout.shrink).toBeGreaterThanOrEqual(MIN_SHRINK);
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines.length).toBeLessThanOrEqual(4);
  });

  it("hard-breaks a single over-wide word at cluster boundaries", () => {
    const doc = style("vertical-clean", {
      typography: { ...style("vertical-clean").typography, sizePct: 14 },
      layout: { ...style("vertical-clean").layout, maxWidthPct: 30, maxLines: 4 },
    });
    const layout = lay(doc, words(["Antidisestablishmentarianism"]));
    expect(layout.words.length).toBeGreaterThan(1);
    expect(layout.words.map((word) => word.text).join("")).toBe("Antidisestablishmentarianism");
  });

  it("breaks Devanagari without splitting a cluster", () => {
    const doc = style("vertical-clean", {
      typography: { ...style("vertical-clean").typography, sizePct: 14 },
      layout: { ...style("vertical-clean").layout, maxWidthPct: 26, maxLines: 4 },
    });
    const layout = lay(doc, words(["ट्रांसक्रिप्ट"]));
    const rejoined = layout.words.map((word) => word.text).join("");
    expect(rejoined).toBe("ट्रांसक्रिप्ट");
    for (const word of layout.words) {
      // A piece never starts with a combining mark: that would be a split cluster.
      expect(/^\p{M}/u.test(word.text), word.text).toBe(false);
    }
  });

  it("scales identically at 1080p and at the 540p proxy", () => {
    const doc = style("punch-pop");
    const list = words(["Bhai", "aaj", "hum", "baat"]);
    const master = lay(doc, list, 100, GOLDEN_CANVAS);
    const proxy = lay(doc, list, 100, PROXY_CANVAS);
    // Coordinates are quantised to three decimals, so at the proxy size the
    // ratio carries a few parts per hundred thousand of rounding.
    expect(master.fontSizePx / proxy.fontSizePx).toBeCloseTo(2, 3);
    expect(rectWidth(master.box) / rectWidth(proxy.box)).toBeCloseTo(2, 3);
    expect(master.box[0] / proxy.box[0]).toBeCloseTo(2, 3);
  });

  it("places the block against the style's anchor", () => {
    const doc = style("vertical-clean");
    const layout = lay(doc, words(["one", "two"]));
    const centre = (layout.box[0] + layout.box[2]) / 2;
    expect(centre).toBeCloseTo(doc.layout.x * GOLDEN_CANVAS.width, 1);
    expect(layout.box[3]).toBeCloseTo(doc.layout.y * GOLDEN_CANVAS.height, 1);
  });

  it("lets a segment position override the style's anchor", () => {
    const layout = layoutSegment({
      style: style("vertical-clean"),
      segment: {
        id: "seg",
        startMs: 0,
        endMs: 3000,
        position: { x: 0.25, y: 0.25, anchor: "top-left" },
      },
      words: words(["one", "two"]),
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      tMs: 0,
    });
    expect(layout.box[0]).toBeCloseTo(0.25 * GOLDEN_CANVAS.width, 1);
    expect(layout.box[1]).toBeCloseTo(0.25 * GOLDEN_CANVAS.height, 1);
  });

  it("clamps a caption back inside the safe area", () => {
    const layout = layoutSegment({
      style: style("vertical-clean"),
      segment: {
        id: "seg",
        startMs: 0,
        endMs: 3000,
        position: { x: 0.5, y: 0.995, anchor: "bottom-center" },
      },
      words: words(["one", "two"]),
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      tMs: 0,
    });
    expect(layout.clampedToSafeArea).toBe(true);
    const margin = ((style("vertical-clean").layout.safeAreaPct ?? 0) / 100) * GOLDEN_CANVAS.height;
    expect(layout.box[3]).toBeLessThanOrEqual(GOLDEN_CANVAS.height - margin + 0.5);
  });

  it("aligns lines left, centre and right inside the block", () => {
    const list = words(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]);
    const base = style("vertical-clean");
    const left = lay({ ...base, layout: { ...base.layout, align: "left" } }, list);
    const right = lay({ ...base, layout: { ...base.layout, align: "right" } }, list);
    expect(left.lines.length).toBeGreaterThan(1);
    expect(left.lines[0]?.box[0]).toBeLessThanOrEqual(left.lines[1]?.box[0] ?? 0);
    expect(right.lines[0]?.box[2]).toBeGreaterThanOrEqual(right.lines[1]?.box[2] ?? 0);
  });

  it("pads the block box by the style's box padding", () => {
    const boxed = style("karaoke-fill");
    const layout = lay(boxed, words(["one", "two"]));
    const padding = (boxed.box.paddingPct / 100) * layout.fontSizePx;
    expect(layout.paddedBox[0]).toBeCloseTo(layout.box[0] - padding, 2);
    expect(rectHeight(layout.paddedBox)).toBeGreaterThan(rectHeight(layout.box));
  });

  it("keeps every word box on its own line and in reading order", () => {
    const layout = lay(
      style("vertical-clean"),
      words(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]),
    );
    layout.words.forEach((word, index) => {
      expect(word.index).toBe(index);
      expect(layout.lines[word.lineIndex]?.words).toContain(word);
    });
  });

  it("carries the emphasis preset and speaker through to the word box", () => {
    const layout = lay(style("punch-pop"), [
      { wid: "0:0", t: "boom", s: 0, e: 3000, sp: "sp2", emphasisPresetId: "pop" },
    ]);
    expect(layout.words[0]?.emphasisPresetId).toBe("pop");
    expect(layout.words[0]?.sp).toBe("sp2");
  });

  it("drops whitespace-only words rather than laying out a gap", () => {
    expect(lay(style("vertical-clean"), words(["one", "  ", "two"])).words).toHaveLength(2);
  });

  it("rejects an impossible canvas", () => {
    expect(() =>
      layoutSegment({
        style: style("vertical-clean"),
        segment: { id: "seg", startMs: 0, endMs: 1 },
        words: words(["a"]),
        canvas: { width: 0, height: 0 },
        registry,
        shaper,
        tMs: 0,
      }),
    ).toThrow(RenderError);
  });
});

describe("helpers", () => {
  it("counts a caption's characters including the spaces", () => {
    expect(captionCharacterCount(words(["ab", "cd"]))).toBe(5);
    expect(captionCharacterCount([])).toBe(0);
  });

  it("names the empty caption rather than laying out nothing", () => {
    expect(() => assertLayoutable([], "seg-1")).toThrow(/no words/);
    expect(() => assertLayoutable(words(["a"]), "seg-1")).not.toThrow();
  });

  it("maps every anchor to its offsets", () => {
    expect(__testing.anchorOffsets("top-left")).toEqual({ h: 0, v: 0 });
    expect(__testing.anchorOffsets("center")).toEqual({ h: 0.5, v: 0.5 });
    expect(__testing.anchorOffsets("bottom-right")).toEqual({ h: 1, v: 1 });
    expect(__testing.anchorOffsets("middle-left")).toEqual({ h: 0, v: 0.5 });
  });

  it("computes alignment offsets", () => {
    expect(__testing.alignOffset("left", 100, 40)).toBe(0);
    expect(__testing.alignOffset("center", 100, 40)).toBe(30);
    expect(__testing.alignOffset("right", 100, 40)).toBe(60);
  });

  it("unions boxes and answers an empty list", () => {
    expect(__testing.unionBox([])).toEqual([0, 0, 0, 0]);
    expect(
      __testing.unionBox([
        [0, 0, 10, 10],
        [5, -5, 20, 5],
      ]),
    ).toEqual([0, -5, 20, 10]);
  });
});
