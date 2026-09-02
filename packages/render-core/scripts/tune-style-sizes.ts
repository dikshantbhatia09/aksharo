/**
 * Tunes `typography.scriptScale` so no caption is ever shrunk to fit.
 *
 * The segmenter's budgets — 32 Latin, 24 Devanagari, 22 Tamil characters a line
 * (`09 §3`) — are readability decisions and do not move. Neither does a style's
 * `sizePct`: that is the size the style was drawn for, and Latin keeps it.
 *
 * What moves is the **per-script multiplier**. A budget is counted in base
 * characters, with combining marks excluded, because that is what reading speed
 * depends on; width is a different question, and a 22-character Tamil line is
 * around 37 code points and roughly twice as wide as 32 characters of Latin.
 * Scaling only the scripts that need it keeps a creator caption a creator
 * caption in Latin and still makes it fit in Devanagari and Tamil.
 *
 * The search bisects each script's multiplier independently against
 * `worstFitForScript`, which measures only the layouts that multiplier can move.
 * Bisection rather than a multiplicative step, because the shrink the layout
 * reports is clamped at `MIN_SHRINK` and a style already on the floor cannot say
 * how far past it is.
 *
 *   pnpm --filter @montaj/render-core styles:tune -- --write
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { loadSystemStyles, type StyleDoc } from "@montaj/caption-styles";

import { scriptScaleKey, type WordScript } from "../src/script.js";
import {
  budgetProbes,
  type FitContext,
  LANDSCAPE_CANVAS,
  LANDSCAPE_MIN_SHRINK,
  PORTRAIT_CANVAS,
  PORTRAIT_MIN_SHRINK,
  worstFitForScript,
} from "../src/styles/fit.js";
import { createFixtureRenderer } from "../src/testing.js";

const require = createRequire(__filename);

/** The scripts the catalogue is tuned for; anything else falls back to 1. */
const SCRIPTS: readonly WordScript[] = ["latin", "devanagari", "tamil"];

function withScale(style: StyleDoc, script: WordScript, scale: number): StyleDoc {
  return {
    ...style,
    typography: {
      ...style.typography,
      scriptScale: { ...style.typography.scriptScale, [scriptScaleKey(script)]: scale },
    },
  };
}

/** True when a style at this multiplier clears both canvases for one script. */
function fits(style: StyleDoc, script: WordScript, scale: number, context: FitContext): boolean {
  const candidate = withScale(style, script, scale);
  const probes = [
    ...budgetProbes(candidate, context, PORTRAIT_CANVAS),
    ...budgetProbes(candidate, context, LANDSCAPE_CANVAS),
  ];
  const portrait = worstFitForScript(candidate, probes, PORTRAIT_CANVAS, context, "9:16", script);
  if (portrait !== undefined && portrait.shrink < PORTRAIT_MIN_SHRINK) return false;
  const landscape = worstFitForScript(candidate, probes, LANDSCAPE_CANVAS, context, "16:9", script);
  return landscape === undefined || landscape.shrink >= LANDSCAPE_MIN_SHRINK;
}

/** The largest multiplier that still fits, capped at 1 — this never magnifies. */
function largestFittingScale(style: StyleDoc, script: WordScript, context: FitContext): number {
  if (fits(style, script, 1, context)) return 1;
  let low = 0.2;
  let high = 1;
  for (let step = 0; step < 22; step += 1) {
    const middle = (low + high) / 2;
    if (fits(style, script, middle, context)) low = middle;
    else high = middle;
  }
  // Round down to two decimals so the committed number is the one that was tested.
  const rounded = Math.floor(low * 100) / 100;
  return fits(style, script, rounded, context) ? rounded : Math.floor((low - 0.01) * 100) / 100;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const context = await createFixtureRenderer();
  const stylesDir = resolve(
    dirname(require.resolve("@montaj/caption-styles/package.json")),
    "styles",
  );

  const neededLatin: string[] = [];
  let changed = 0;

  for (const style of loadSystemStyles()) {
    const scales: Record<string, number> = {};
    for (const script of SCRIPTS) {
      const scale = largestFittingScale(style, script, context);
      if (scale >= 1) continue;
      scales[scriptScaleKey(script)] = scale;
      if (script === "latin") neededLatin.push(`${style.id} (${scale.toFixed(2)})`);
    }

    if (Object.keys(scales).length === 0) {
      console.log(
        `ok   ${style.id.padEnd(22)} ${String(style.typography.sizePct).padStart(5)}%  no scaling needed`,
      );
      continue;
    }
    changed += 1;
    const summary = SCRIPTS.map(
      (script) => `${scriptScaleKey(script)} ${(scales[scriptScaleKey(script)] ?? 1).toFixed(2)}`,
    ).join("  ");
    console.log(
      `tune ${style.id.padEnd(22)} ${String(style.typography.sizePct).padStart(5)}%  ${summary}`,
    );
    if (!write) continue;

    // Insert or replace `scriptScale` inside `typography`, leaving every other
    // line — and every other field — byte-identical.
    const path = join(stylesDir, `${style.id}.json`);
    const source = readFileSync(path, "utf8");
    const block = JSON.stringify(scales);
    const next = /"scriptScale":\s*\{[^}]*\}/.test(source)
      ? source.replace(/"scriptScale":\s*\{[^}]*\}/, `"scriptScale": ${block}`)
      : source.replace(
          /(\n(\s*)"textTransform":\s*"[a-z]+")/,
          (_match, line: string, indent: string) => `${line},\n${indent}"scriptScale": ${block}`,
        );
    if (next === source) throw new Error(`could not write scriptScale into ${style.id}.json`);
    writeFileSync(path, next, "utf8");
  }

  console.log(
    `\n${String(changed)} of 30 styles ${write ? "given" : "would be given"} a scriptScale`,
  );
  console.log(
    neededLatin.length === 0
      ? "no style needed its Latin size reduced"
      : `Latin also had to be scaled for: ${neededLatin.join(", ")}`,
  );
  if (!write) console.log("re-run with --write to apply");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
