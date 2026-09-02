/**
 * Re-tunes every system style's type size so the renderer never has to shrink it.
 *
 * The segmenter's character budgets (32 Latin, 24 Devanagari, 22 Tamil per line,
 * `09 §3`) are readability decisions and do not move. A style's `sizePct` is a
 * look decision and does: if a budget-filling caption in any script has to be
 * scaled down to fit the box, then the picker's tile, the editor's preview and
 * the burned-in frame are three different sizes, and the document is lying about
 * what it draws.
 *
 * The search is a bisection on `sizePct` against `worstFit`, over the four
 * caption fixtures **and** a budget-filling caption in each script, at every
 * instant a `wordsPerCue` style rotates through, on both the portrait master and
 * the landscape canvas. Nothing else in the document is touched — not the name,
 * not the parity flags, not the colours.
 *
 *   pnpm --filter @montaj/render-core styles:tune -- --write
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { loadSystemStyles, type StyleDoc } from "@montaj/caption-styles";

import {
  budgetProbes,
  type FitContext,
  type FitProbe,
  LANDSCAPE_CANVAS,
  LANDSCAPE_MIN_SHRINK,
  PORTRAIT_CANVAS,
  PORTRAIT_MIN_SHRINK,
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

const require = createRequire(__filename);

/** Two decimals: finer than a tenth of a pixel of type at 4K, and readable. */
function roundSize(value: number): number {
  return Math.round(value * 100) / 100;
}

/** True when a style at `sizePct` clears both canvases' floors. */
function fits(style: StyleDoc, sizePct: number, context: FitContext): boolean {
  const candidate: StyleDoc = { ...style, typography: { ...style.typography, sizePct } };
  const probes = [...fixtureProbes(), ...budgetProbes(candidate)];
  if (worstFit(candidate, probes, PORTRAIT_CANVAS, context, "9:16").shrink < PORTRAIT_MIN_SHRINK) {
    return false;
  }
  return (
    worstFit(candidate, probes, LANDSCAPE_CANVAS, context, "16:9").shrink >= LANDSCAPE_MIN_SHRINK
  );
}

/**
 * The largest `sizePct` that still fits. Bisection rather than a multiplicative
 * step because the shrink the layout reports is clamped at `MIN_SHRINK`, so a
 * style already on the floor cannot say how far past it is.
 */
function largestFittingSize(style: StyleDoc, context: FitContext): number {
  const authored = style.typography.sizePct;
  if (fits(style, authored, context)) return authored;

  let low = 0.5;
  let high = authored;
  for (let step = 0; step < 22; step += 1) {
    const middle = (low + high) / 2;
    if (fits(style, middle, context)) low = middle;
    else high = middle;
  }
  // Round down to two decimals so the committed number is the one that was tested.
  const rounded = Math.floor(low * 100) / 100;
  return fits(style, rounded, context) ? rounded : roundSize(low - 0.01);
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const context = await createFixtureRenderer();
  const stylesDir = resolve(
    dirname(require.resolve("@montaj/caption-styles/package.json")),
    "styles",
  );

  let changed = 0;
  for (const style of loadSystemStyles()) {
    const authored = style.typography.sizePct;
    const tuned = largestFittingSize(style, context);
    if (Math.abs(tuned - authored) < 0.005) {
      console.log(`ok   ${style.id.padEnd(22)} ${String(authored).padStart(6)}%  (unchanged)`);
      continue;
    }
    changed += 1;
    console.log(
      `tune ${style.id.padEnd(22)} ${String(authored).padStart(6)}% → ${tuned.toFixed(2)}%  (${((tuned / authored - 1) * 100).toFixed(0)}%)`,
    );
    if (!write) continue;

    // Rewrite only `typography.sizePct`, in place, so the diff shows one line.
    const path = join(stylesDir, `${style.id}.json`);
    const source = readFileSync(path, "utf8");
    const next = source.replace(
      /("sizePct":\s*)(-?\d+(?:\.\d+)?)/,
      (_match, prefix: string) => `${prefix}${String(tuned)}`,
    );
    if (next === source) throw new Error(`could not rewrite sizePct in ${style.id}.json`);
    writeFileSync(path, next, "utf8");
  }

  console.log(`\n${String(changed)} of 30 styles ${write ? "retuned" : "would be retuned"}`);
  if (!write) console.log("re-run with --write to apply");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
