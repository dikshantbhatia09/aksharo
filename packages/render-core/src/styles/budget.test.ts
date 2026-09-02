import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap, type StyleDoc } from "@montaj/caption-styles";

import { RenderError } from "../errors.js";
import { createFontRegistry } from "../fonts/registry.js";
import { charCount, limitsFor } from "../script.js";
import { createFixtureRenderer } from "../testing.js";
import {
  averageAdvanceEm,
  BUDGET_SAMPLES,
  fitBudget,
  type FitBudgetOptions,
  fitBudgetsByScript,
  MIN_BUDGET_CHARS,
  READABILITY_MAX_LINES,
} from "./budget.js";
import { LANDSCAPE_CANVAS, PORTRAIT_CANVAS } from "./fit.js";

/**
 * `fitBudget` is the join between the segmenter and the renderer (decision D78):
 * the segmenter cuts to the number it returns and the layout wraps to the same
 * number, so the two cannot disagree about how long a caption may be.
 */

const catalogue = loadSystemStyleMap();
let context: Omit<FitBudgetOptions, "style" | "script" | "canvas">;

function style(id: string): StyleDoc {
  const found = catalogue.get(id);
  if (found === undefined) throw new Error(`no style ${id}`);
  return found;
}

beforeAll(async () => {
  context = await createFixtureRenderer();
});

describe("averageAdvanceEm", () => {
  it("measures through the real shaper, in em, per base character", () => {
    const advance = averageAdvanceEm({
      style: style("vertical-clean"),
      script: "latin",
      ...context,
    });
    // Latin text averages roughly half an em a character; anything wildly outside
    // that means the measurement lost the font or the character count.
    expect(advance).toBeGreaterThan(0.3);
    expect(advance).toBeLessThan(0.9);
  });

  it("charges Indic scripts more per base character, which is the whole point", () => {
    const doc = style("vertical-clean");
    const latin = averageAdvanceEm({ style: doc, script: "latin", ...context });
    const tamil = averageAdvanceEm({ style: doc, script: "tamil", ...context });
    expect(tamil).toBeGreaterThan(latin);
  });

  it("accounts for the style's own text transform", () => {
    const lower = style("vertical-clean");
    const upper: StyleDoc = {
      ...lower,
      typography: { ...lower.typography, textTransform: "uppercase" },
    };
    expect(averageAdvanceEm({ style: upper, script: "latin", ...context })).toBeGreaterThan(
      averageAdvanceEm({ style: lower, script: "latin", ...context }),
    );
  });

  it("accounts for letter spacing", () => {
    const tight = style("vertical-clean");
    const loose: StyleDoc = {
      ...tight,
      typography: { ...tight.typography, letterSpacingEm: 0.2 },
    };
    expect(averageAdvanceEm({ style: loose, script: "latin", ...context })).toBeGreaterThan(
      averageAdvanceEm({ style: tight, script: "latin", ...context }),
    );
  });

  it("raises render/no-font rather than guessing when nothing can draw the sample", () => {
    // The registry's last resort is "anything that covers the code points", so a
    // missing family alone is not enough — an empty registry is.
    expect(() =>
      averageAdvanceEm({
        style: style("vertical-clean"),
        script: "tamil",
        registry: createFontRegistry(),
        shaper: context.shaper,
      }),
    ).toThrow(RenderError);
  });
});

describe("fitBudget", () => {
  it("never exceeds the readability cap", () => {
    for (const doc of catalogue.values()) {
      for (const script of ["latin", "devanagari", "tamil"] as const) {
        for (const canvas of [PORTRAIT_CANVAS, LANDSCAPE_CANVAS]) {
          const budget = fitBudget({ style: doc, script, canvas, ...context });
          expect(budget.maxChars, `${doc.id}/${script}`).toBeLessThanOrEqual(
            limitsFor(script).maxCharsPerLine,
          );
          expect(budget.maxChars, `${doc.id}/${script}`).toBeGreaterThanOrEqual(1);
          expect(budget.maxLines, `${doc.id}/${script}`).toBeLessThanOrEqual(READABILITY_MAX_LINES);
          expect(budget.maxLines, `${doc.id}/${script}`).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it("gives a 16:9 frame a bigger budget than 9:16 for the same style", () => {
    const doc = style("vertical-clean");
    const portrait = fitBudget({
      style: doc,
      script: "latin",
      canvas: PORTRAIT_CANVAS,
      ...context,
    });
    const landscape = fitBudget({
      style: doc,
      script: "latin",
      canvas: LANDSCAPE_CANVAS,
      ...context,
    });
    expect(landscape.maxChars).toBeGreaterThan(portrait.maxChars);
    // A 16:9 frame is wide enough that readability, not width, decides.
    expect(landscape.limitedByFit).toBe(false);
    expect(portrait.limitedByFit).toBe(true);
  });

  it("gives a larger style a smaller budget", () => {
    const small = style("subtitle-classic");
    const large = style("hype-bold");
    const of = (doc: StyleDoc): number =>
      fitBudget({ style: doc, script: "latin", canvas: PORTRAIT_CANVAS, ...context }).maxChars;
    expect(of(large)).toBeLessThan(of(small));
  });

  it("is unchanged by the canvas scale, because every size is relative", () => {
    const doc = style("vertical-clean");
    const master = fitBudget({ style: doc, script: "latin", canvas: PORTRAIT_CANVAS, ...context });
    const proxy = fitBudget({
      style: doc,
      script: "latin",
      canvas: { width: 540, height: 960 },
      ...context,
    });
    expect(proxy.maxChars).toBe(master.maxChars);
    expect(proxy.maxLines).toBe(master.maxLines);
  });

  it("is a pure function of its inputs", () => {
    const doc = style("karaoke-fill");
    const once = fitBudget({ style: doc, script: "tamil", canvas: PORTRAIT_CANVAS, ...context });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        fitBudget({ style: doc, script: "tamil", canvas: PORTRAIT_CANVAS, ...context }),
      ).toEqual(once);
    }
  });

  it("flags a budget too small to be comfortable rather than inflating it", () => {
    const doc = style("vertical-clean");
    const huge: StyleDoc = { ...doc, typography: { ...doc.typography, sizePct: 20 } };
    const budget = fitBudget({ style: huge, script: "latin", canvas: PORTRAIT_CANVAS, ...context });
    expect(budget.maxChars).toBeLessThan(MIN_BUDGET_CHARS);
    expect(budget.belowComfortableMinimum).toBe(true);
    // Honoured, not raised: inflating it would put the overflow back.
    expect(budget.maxChars).toBeGreaterThanOrEqual(1);
  });

  it("narrows the budget when a box eats the width", () => {
    const doc = style("vertical-clean");
    const padded: StyleDoc = {
      ...doc,
      box: { ...doc.box, enabled: true, paddingPct: 120 },
    };
    expect(
      fitBudget({ style: padded, script: "latin", canvas: PORTRAIT_CANVAS, ...context }).maxChars,
    ).toBeLessThan(
      fitBudget({ style: doc, script: "latin", canvas: PORTRAIT_CANVAS, ...context }).maxChars,
    );
  });

  it("respects the scriptScale multiplier: smaller type, more characters", () => {
    const doc = style("vertical-clean");
    const unscaled: StyleDoc = {
      ...doc,
      typography: { ...doc.typography, scriptScale: undefined },
    };
    const scaled = fitBudget({ style: doc, script: "tamil", canvas: PORTRAIT_CANVAS, ...context });
    const plain = fitBudget({
      style: unscaled,
      script: "tamil",
      canvas: PORTRAIT_CANVAS,
      ...context,
    });
    expect(scaled.maxChars).toBeGreaterThan(plain.maxChars);
  });

  it("rejects an impossible canvas rather than dividing by zero", () => {
    expect(() =>
      fitBudget({
        style: style("vertical-clean"),
        script: "latin",
        canvas: { width: 0, height: 0 },
        ...context,
      }),
    ).toThrow(RenderError);
  });
});

describe("the committed samples", () => {
  it("are in the script they claim and long enough to average over", () => {
    for (const script of ["latin", "devanagari", "tamil"] as const) {
      expect(charCount(BUDGET_SAMPLES[script]), script).toBeGreaterThan(30);
      expect(BUDGET_SAMPLES[script], script).toContain(" ");
    }
    expect(BUDGET_SAMPLES.devanagari).toMatch(/\p{Script=Devanagari}/u);
    expect(BUDGET_SAMPLES.tamil).toMatch(/\p{Script=Tamil}/u);
  });
});

describe("fitBudgetsByScript", () => {
  it("returns the shape the segmenter takes as maxCharsByScript", () => {
    const { maxCharsByScript, maxLines } = fitBudgetsByScript({
      style: style("vertical-clean"),
      canvas: PORTRAIT_CANVAS,
      ...context,
    });
    expect(Object.keys(maxCharsByScript).sort()).toEqual(["devanagari", "latin", "other", "tamil"]);
    for (const value of Object.values(maxCharsByScript)) expect(value).toBeGreaterThan(0);
    expect(maxLines).toBeLessThanOrEqual(READABILITY_MAX_LINES);
  });

  it("takes the tightest line count across the scripts", () => {
    const { maxLines } = fitBudgetsByScript({
      style: style("quote-frame"),
      canvas: PORTRAIT_CANVAS,
      ...context,
    });
    // `quote-frame` asks for four lines; the readability cap is two.
    expect(maxLines).toBe(READABILITY_MAX_LINES);
  });
});
