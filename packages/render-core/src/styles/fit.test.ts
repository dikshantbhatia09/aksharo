import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyles } from "@montaj/caption-styles";

import { layoutSegment } from "../layout/layout.js";
import { charCount, limitsFor } from "../script.js";
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
} from "./fit.js";

/**
 * The catalogue has to be drawable at its own type size.
 *
 * `shrink < 1` means the renderer scaled the caption down to make it fit, so the
 * picker tile, the editor preview and the burned-in frame are three different
 * sizes, and — worse — two captions in the same video are two different sizes
 * because one is longer than the other. The segmenter's character budgets are
 * readability decisions and do not move (`09 §3`); a style's `sizePct` is a look
 * decision, and `scripts/tune-style-sizes.ts` is what sets it.
 */

const styles = loadSystemStyles();
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

describe("every system style fits at the portrait master", () => {
  it.each(styles.map((style) => [style.id, style] as const))(
    "%s draws the four caption fixtures at 1080×1920 without shrinking",
    (id, style) => {
      const worst = worstFit(style, fixtureProbes(), PORTRAIT_CANVAS, context, "9:16");
      expect(
        worst.shrink,
        `${id} shrinks to ${worst.shrink.toFixed(3)} on ${worst.probe} at ${String(worst.tMs)} ms`,
      ).toBeGreaterThanOrEqual(PORTRAIT_MIN_SHRINK);
    },
  );

  it.each(styles.map((style) => [style.id, style] as const))(
    "%s also fits a budget-filling line in every script",
    (id, style) => {
      const worst = worstFit(style, budgetProbes(style), PORTRAIT_CANVAS, context, "9:16");
      expect(
        worst.shrink,
        `${id} shrinks to ${worst.shrink.toFixed(3)} on ${worst.probe} at ${String(worst.tMs)} ms`,
      ).toBeGreaterThanOrEqual(PORTRAIT_MIN_SHRINK);
    },
  );
});

describe("every system style survives the landscape canvas", () => {
  it.each(styles.map((style) => [style.id, style] as const))(
    "%s draws the four caption fixtures at 1920×1080",
    (id, style) => {
      const worst = worstFit(style, fixtureProbes(), LANDSCAPE_CANVAS, context, "16:9");
      expect(
        worst.shrink,
        `${id} shrinks to ${worst.shrink.toFixed(3)} on ${worst.probe} at ${String(worst.tMs)} ms`,
      ).toBeGreaterThanOrEqual(LANDSCAPE_MIN_SHRINK);
    },
  );

  it.each(styles.map((style) => [style.id, style] as const))(
    "%s also fits a budget-filling line at 1920×1080",
    (id, style) => {
      const worst = worstFit(style, budgetProbes(style), LANDSCAPE_CANVAS, context, "16:9");
      expect(
        worst.shrink,
        `${id} shrinks to ${worst.shrink.toFixed(3)} on ${worst.probe} at ${String(worst.tMs)} ms`,
      ).toBeGreaterThanOrEqual(LANDSCAPE_MIN_SHRINK);
    },
  );
});

describe("the budget-filling probe", () => {
  it("fills the script's line budget without exceeding it", () => {
    for (const script of ["latin", "devanagari", "tamil"] as const) {
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
    const words = budgetFillingWords("tamil", style.layout.maxLines);
    const layout = layoutSegment({
      style,
      segment: { id: "probe", startMs: 0, endMs: 3000 },
      words,
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
    const tiny = { ...style, typography: { ...style.typography, sizePct: 30 } };
    const worst = worstFit(tiny, budgetProbes(tiny), PORTRAIT_CANVAS, context, "9:16");
    expect(worst.shrink).toBeLessThan(PORTRAIT_MIN_SHRINK);
    expect(worst.probe).toMatch(/^budget:/);
    expect(worst.canvas).toBe("9:16");
    expect(worst.lines).toBeGreaterThan(0);
  });
});
