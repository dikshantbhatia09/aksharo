import { loadSystemStyles } from "@montaj/caption-styles";

import {
  budgetProbes,
  type FitProbe,
  LANDSCAPE_CANVAS,
  PORTRAIT_CANVAS,
  worstFit,
} from "../src/styles/fit.js";
import { CAPTION_FIXTURES, createFixtureRenderer, GOLDEN_TIMESTAMPS_MS } from "../src/testing.js";

/** The four caption fixtures, at exactly the instants the goldens capture. */
function fixtureProbes(): FitProbe[] {
  return CAPTION_FIXTURES.map((fixture) => ({
    name: `fixture:${fixture.name}`,
    script: fixture.script,
    words: fixture.words,
    segment: fixture.segment,
    timestamps: GOLDEN_TIMESTAMPS_MS,
  }));
}

async function main(): Promise<void> {
  const context = await createFixtureRenderer();
  const fixtures = fixtureProbes();
  let bad = 0;
  for (const style of loadSystemStyles()) {
    const probes = [...fixtures, ...budgetProbes(style)];
    const portrait = worstFit(style, probes, PORTRAIT_CANVAS, context, "9:16");
    const landscape = worstFit(style, probes, LANDSCAPE_CANVAS, context, "16:9");
    const flag = portrait.shrink < 0.95 || landscape.shrink < 0.9 ? "FAIL" : "ok  ";
    if (flag === "FAIL") bad += 1;
    console.log(
      `${flag} ${style.id.padEnd(22)} size ${String(style.typography.sizePct).padStart(5)}%  9:16 ${portrait.shrink.toFixed(3)} (${portrait.probe}@${String(portrait.tMs)}, ${String(portrait.lines)}L)  16:9 ${landscape.shrink.toFixed(3)} (${landscape.probe})`,
    );
  }
  console.log(`\n${String(bad)} of 30 styles fail the fit target today`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
