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
import { CAPTION_FIXTURES, createFixtureRenderer, GOLDEN_TIMESTAMPS_MS } from "../testing.js";
import {
  budgetFillingWords,
  budgetProbes,
  type FitContext,
  type FitProbe,
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
 * The budgets (32 Latin, 24 Devanagari, 22 Tamil characters a line, `09 §3`) are
 * readability decisions and do not move, and neither does `sizePct`. What moves
 * is `typography.scriptScale`, tuned by `scripts/tune-style-sizes.ts` per script,
 * so a Latin caption keeps its own size and an Indic one takes the size a
 * full-budget line of its own script needs.
 */

const styles = loadSystemStyles();
const SCRIPTS: readonly WordScript[] = ["latin", "devanagari", "tamil"];
let context: FitContext;

beforeAll(async () => {
  context = await createFixtureRenderer();
});

/** The four caption fixtures at exactly the instants the goldens capture. */
function fixtureProbes(): FitProbe[] {
  return CAPTION_FIXTURES.map((fixture) => ({
    name: `fixture:${fixture.name}`,
    script: fixture.script,
    words: fixture.words,
    segment: fixture.segment,
    timestamps: GOLDEN_TIMESTAMPS_MS,
  }));
}

const cases = styles.map((style) => [style.id, style] as const);

describe("the four caption fixtures", () => {
  it.each(cases)("%s draws them at 1080×1920 without shrinking", (id, style) => {
    const worst = worstFit(style, fixtureProbes(), PORTRAIT_CANVAS, context, "9:16");
    expect(
      worst.shrink,
      `${id} shrinks to ${worst.shrink.toFixed(3)} on ${worst.probe} at ${String(worst.tMs)} ms`,
    ).toBeGreaterThanOrEqual(PORTRAIT_MIN_SHRINK);
  });

  it.each(cases)("%s draws them at 1920×1080 without shrinking", (id, style) => {
    const worst = worstFit(style, fixtureProbes(), LANDSCAPE_CANVAS, context, "16:9");
    expect(
      worst.shrink,
      `${id} shrinks to ${worst.shrink.toFixed(3)} on ${worst.probe} at ${String(worst.tMs)} ms`,
    ).toBeGreaterThanOrEqual(LANDSCAPE_MIN_SHRINK);
  });
});

describe.each(SCRIPTS)("a full-budget %s line", (script) => {
  it.each(cases)(`%s fits it at 1080×1920`, (id, style) => {
    const probes = [...fixtureProbes(), ...budgetProbes(style)];
    const worst = worstFitForScript(style, probes, PORTRAIT_CANVAS, context, "9:16", script);
    if (worst === undefined) return; // the style never draws this script
    expect(
      worst.shrink,
      `${id} shrinks ${script} to ${worst.shrink.toFixed(3)} on ${worst.probe} at ${String(worst.tMs)} ms`,
    ).toBeGreaterThanOrEqual(PORTRAIT_MIN_SHRINK);
  });

  it.each(cases)(`%s fits it at 1920×1080`, (id, style) => {
    const probes = [...fixtureProbes(), ...budgetProbes(style)];
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
    const huge = { ...style, typography: { ...style.typography, sizePct: 30 } };
    const worst = worstFit(huge, budgetProbes(huge), PORTRAIT_CANVAS, context, "9:16");
    expect(worst.shrink).toBeLessThan(PORTRAIT_MIN_SHRINK);
    expect(worst.probe).toMatch(/^budget:/);
    expect(worst.canvas).toBe("9:16");
    expect(worst.lines).toBeGreaterThan(0);
  });

  it("measures only the layouts a script's multiplier can move", () => {
    const style = styles.find((entry) => entry.id === "vertical-clean");
    expect(style).toBeDefined();
    if (style === undefined) return;
    const probes = budgetProbes(style);
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
