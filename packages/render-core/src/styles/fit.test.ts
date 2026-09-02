import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyles } from "@montaj/caption-styles";

import { layoutSegment } from "../layout/layout.js";
import {
  charCount,
  limitsFor,
  scriptScaleFor,
  scriptScaleKey,
  type WordScript,
} from "../script.js";
import { createFixtureRenderer } from "../testing.js";
import {
  budgetFillingWords,
  type FitProbe,
  budgetProbes,
  type FitContext,
  LANDSCAPE_CANVAS,
  LANDSCAPE_MIN_SHRINK,
  PORTRAIT_CANVAS,
  PORTRAIT_MIN_SHRINK,
  sweep,
  worstFit,
  worstFitForScript,
} from "./fit.js";

/**
 * The catalogue has to be drawable at the size its document asks for.
 *
 * `shrink < 1` means the renderer scaled the caption down to make it fit, so two
 * captions in the same video are two different sizes because one is longer than
 * the other, and the picker's tile — short preview text, never shrunk — shows a
 * size no real caption will use.
 *
 * Every probe is a caption cut to the budget `fitBudget` measures for that
 * (style, script, canvas) — the caption the segmenter would actually produce
 * (decision D78). The 32/24/22 table is the readability maximum the budget is
 * capped by, not the caption length: a full 32-character Latin line is about
 * 16 em and does not fit a 9:16 frame at any creator type size, so the budget
 * comes down instead of the type.
 *
 * `typography.scriptScale` still earns its place on readability rather than on
 * fit: without it a Tamil budget collapses to five or six characters — one short
 * word a line — where a modest reduction doubles it.
 */

const styles = loadSystemStyles();
const SCRIPTS: readonly WordScript[] = ["latin", "devanagari", "tamil"];
let context: FitContext;

beforeAll(async () => {
  context = await createFixtureRenderer();
});

const cases = styles.map((style) => [style.id, style] as const);

describe.each(SCRIPTS)("a full-budget %s line", (script) => {
  it.each(cases)(`%s fits it at 1080×1920`, (id, style) => {
    const probes = budgetProbes(style, context, PORTRAIT_CANVAS);
    const worst = worstFitForScript(style, probes, PORTRAIT_CANVAS, context, "9:16", script);
    if (worst === undefined) return; // the style never draws this script
    expect(
      worst.shrink,
      `${id} shrinks ${script} to ${worst.shrink.toFixed(3)} on ${worst.probe} at ${String(worst.tMs)} ms`,
    ).toBeGreaterThanOrEqual(PORTRAIT_MIN_SHRINK);
  });

  it.each(cases)(`%s fits it at 1920×1080`, (id, style) => {
    const probes = budgetProbes(style, context, LANDSCAPE_CANVAS);
    const worst = worstFitForScript(style, probes, LANDSCAPE_CANVAS, context, "16:9", script);
    if (worst === undefined) return;
    expect(
      worst.shrink,
      `${id} shrinks ${script} to ${worst.shrink.toFixed(3)} on ${worst.probe} at ${String(worst.tMs)} ms`,
    ).toBeGreaterThanOrEqual(LANDSCAPE_MIN_SHRINK);
  });
});

describe("scriptScale", () => {
  it("never magnifies: every multiplier the catalogue ships is at most 1", () => {
    for (const style of styles) {
      for (const [key, scale] of Object.entries(style.typography.scriptScale ?? {})) {
        expect(scale, `${style.id}.${key}`).toBeGreaterThan(0);
        expect(scale, `${style.id}.${key}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("actually changes the type size the layout uses", () => {
    const style = styles.find((entry) => entry.id === "vertical-clean");
    expect(style).toBeDefined();
    if (style === undefined) return;
    const scale = scriptScaleFor(style.typography.scriptScale, "tamil");
    expect(scale).toBeLessThan(1);

    const words = budgetFillingWords("tamil", 1);
    const segment = { id: "s", startMs: 0, endMs: 3000 };
    const scaled = layoutSegment({
      style,
      segment,
      words,
      canvas: PORTRAIT_CANVAS,
      registry: context.registry,
      shaper: context.shaper,
      tMs: 1500,
    });
    const unscaled = layoutSegment({
      style: { ...style, typography: { ...style.typography, scriptScale: undefined } },
      segment,
      words,
      canvas: PORTRAIT_CANVAS,
      registry: context.registry,
      shaper: context.shaper,
      tMs: 1500,
    });
    expect(scaled.fontSizePx).toBeLessThan(unscaled.fontSizePx / scaled.shrink);
    expect(scaled.shrink).toBeGreaterThanOrEqual(PORTRAIT_MIN_SHRINK);
  });

  it("leaves a script it says nothing about alone", () => {
    expect(scriptScaleFor(undefined, "latin")).toBe(1);
    expect(scriptScaleFor({ deva: 0.8 }, "latin")).toBe(1);
    expect(scriptScaleFor({ deva: 0.8 }, "devanagari")).toBe(0.8);
    expect(scriptScaleFor({ deva: 0.8 }, "other")).toBe(1);
  });

  it("ignores a nonsensical multiplier rather than drawing nothing", () => {
    expect(scriptScaleFor({ deva: 0 }, "devanagari")).toBe(1);
    expect(scriptScaleFor({ deva: Number.NaN }, "devanagari")).toBe(1);
    expect(scriptScaleFor({ deva: -1 }, "devanagari")).toBe(1);
  });

  it("keys entries by the lowercase OpenType tag", () => {
    expect(scriptScaleKey("latin")).toBe("latn");
    expect(scriptScaleKey("devanagari")).toBe("deva");
    expect(scriptScaleKey("tamil")).toBe("taml");
    expect(scriptScaleKey("other")).toBe("zyyy");
  });
});

describe("the budget-filling probe", () => {
  it("fills the script's line budget without exceeding it", () => {
    for (const script of SCRIPTS) {
      const budget = limitsFor(script).maxCharsPerLine;
      const words = budgetFillingWords(script, 2);
      expect(words.length, script).toBeGreaterThan(1);
      for (const word of words) {
        expect(
          charCount(word.t),
          `${script}: "${word.t}" alone busts the budget`,
        ).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("produces the number of lines the style allows, not more", () => {
    const style = styles.find((entry) => entry.id === "vertical-clean");
    expect(style).toBeDefined();
    if (style === undefined) return;
    const layout = layoutSegment({
      style,
      segment: { id: "probe", startMs: 0, endMs: 3000 },
      words: budgetFillingWords("tamil", style.layout.maxLines),
      canvas: PORTRAIT_CANVAS,
      registry: context.registry,
      shaper: context.shaper,
      tMs: 1500,
    });
    expect(layout.lines.length).toBe(style.layout.maxLines);
  });

  it("times the words evenly so a wordsPerCue style rotates through every chunk", () => {
    const words = budgetFillingWords("latin", 2, 3000);
    expect(words[0]?.s).toBe(0);
    expect(words[words.length - 1]?.e).toBe(3000);
    expect(sweep(3000, 4)).toEqual([375, 1125, 1875, 2625]);
  });

  it("reports which probe and instant was worst, so a failure names itself", () => {
    const style = styles.find((entry) => entry.id === "vertical-clean");
    expect(style).toBeDefined();
    if (style === undefined) return;
    // A caption cut at the old budget, drawn by a style that has since grown —
    // the "style changed, captions not reflowed yet" state A15 offers to fix.
    const stale: FitProbe = {
      name: "budget:latin",
      script: "latin",
      words: budgetFillingWords("latin", 2, 3000, 32),
      segment: { id: "stale", startMs: 0, endMs: 3000 },
      timestamps: [1500],
    };
    const huge = { ...style, typography: { ...style.typography, sizePct: 24 } };
    const worst = worstFit(huge, [stale], PORTRAIT_CANVAS, context, "9:16");
    expect(worst.shrink).toBeLessThan(PORTRAIT_MIN_SHRINK);
    expect(worst.probe).toBe("budget:latin");
    expect(worst.canvas).toBe("9:16");
    expect(worst.lines).toBeGreaterThan(0);
  });

  it("measures only the layouts a script's multiplier can move", () => {
    const style = styles.find((entry) => entry.id === "vertical-clean");
    expect(style).toBeDefined();
    if (style === undefined) return;
    const probes = budgetProbes(style, context, PORTRAIT_CANVAS);
    expect(worstFitForScript(style, probes, PORTRAIT_CANVAS, context, "9:16", "tamil")?.probe).toBe(
      "budget:tamil",
    );
    // Nothing in a Latin-only probe set is Devanagari, so there is nothing to say.
    const latinOnly = probes.filter((probe) => probe.name === "budget:latin");
    expect(
      worstFitForScript(style, latinOnly, PORTRAIT_CANVAS, context, "9:16", "devanagari"),
    ).toBeUndefined();
  });
});
