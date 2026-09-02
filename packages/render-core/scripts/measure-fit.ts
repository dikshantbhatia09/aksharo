/**
 * Reports each style's measured line budget and the shrink it produces.
 *
 *   pnpm --filter @montaj/render-core styles:fit
 */

import { loadSystemStyles } from "@montaj/caption-styles";

import { type WordScript } from "../src/script.js";
import { fitBudget } from "../src/styles/budget.js";
import {
  budgetProbes,
  LANDSCAPE_CANVAS,
  LANDSCAPE_MIN_SHRINK,
  PORTRAIT_CANVAS,
  PORTRAIT_MIN_SHRINK,
  worstFitForScript,
} from "../src/styles/fit.js";
import { createFixtureRenderer } from "../src/testing.js";

const SCRIPTS: readonly WordScript[] = ["latin", "devanagari", "tamil"];

async function main(): Promise<void> {
  const context = await createFixtureRenderer();
  let failures = 0;

  for (const style of loadSystemStyles()) {
    const parts: string[] = [];
    let bad = false;
    for (const script of SCRIPTS) {
      const portraitBudget = fitBudget({ style, script, canvas: PORTRAIT_CANVAS, ...context });
      const landscapeBudget = fitBudget({ style, script, canvas: LANDSCAPE_CANVAS, ...context });
      const probes = budgetProbes(style, context, PORTRAIT_CANVAS);
      const portrait = worstFitForScript(style, probes, PORTRAIT_CANVAS, context, "9:16", script);
      const landscape = worstFitForScript(
        style,
        budgetProbes(style, context, LANDSCAPE_CANVAS),
        LANDSCAPE_CANVAS,
        context,
        "16:9",
        script,
      );
      const p = portrait?.shrink ?? 1;
      const l = landscape?.shrink ?? 1;
      if (p < PORTRAIT_MIN_SHRINK || l < LANDSCAPE_MIN_SHRINK) bad = true;
      parts.push(
        `${script.slice(0, 4)} ${String(portraitBudget.maxChars).padStart(2)}/${String(landscapeBudget.maxChars).padStart(2)}ch ${p.toFixed(2)}/${l.toFixed(2)}`,
      );
    }
    if (bad) failures += 1;
    console.log(`${bad ? "FAIL" : "ok  "} ${style.id.padEnd(22)} ${parts.join("  ")}`);
  }
  console.log(
    `\n${String(failures)} of 30 styles fail; budgets shown as 9:16/16:9 chars, shrink as 9:16/16:9`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
