import { afterEach, describe, expect, it } from "vitest";

import { resolveBudgets } from "./caption-budgets.js";
import { captionRenderContext, resetCaptionRenderContext } from "./caption-render-context.js";
import { DEFAULT_STYLE_REF } from "./transcript-init.js";

/**
 * The real binding (A11c, after A18b landed `@montaj/fonts` on `main`): the
 * bundled pack's actual bytes, through the actual HarfBuzz shaper, actually
 * measuring `vertical-clean`'s Inter 600 at the 9:16 canvas. Everything else
 * this WP tests goes through the fixture renderer in `transcript-init.test.ts`;
 * this one file is the proof that binding to the real pack works at all.
 */
describe("captionRenderContext", () => {
  afterEach(() => {
    resetCaptionRenderContext();
  });

  it("resolveBudgets reports source: fit for the default style at 9:16", async () => {
    const render = await captionRenderContext();

    const budgets = resolveBudgets({
      script: "latin",
      styleRef: DEFAULT_STYLE_REF,
      render,
    });

    expect(budgets.source).toBe("fit");
    expect(budgets.aspect).toBe("9:16");
    expect(budgets.fitChars).toBeGreaterThan(0);
    // The fit half can only narrow the readability cap, never widen it (D78).
    expect(budgets.maxChars).toBeLessThanOrEqual(budgets.readabilityChars);
  }, 20_000);

  it("builds the context once and reuses it across calls", async () => {
    const first = await captionRenderContext();
    const second = await captionRenderContext();
    expect(second).toBe(first);
  });
});
