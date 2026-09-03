#!/usr/bin/env tsx
/**
 * B20b's crop-window parity gate: measures the max pixel disagreement
 * between the browser exporter's `sampleCropWindow` (`@montaj/render-core`)
 * and the cloud renderer's `buildDynamicCropFilter` (`../src/ffmpeg/crop-
 * expr.ts`) over `crop-fixtures.ts`'s two fixtures, and writes
 * `apps/render/parity/results.json`'s `edits` block — the numeric record
 * `../src/ffmpeg/crop-parity.test.ts` already asserts pass a tolerance on
 * every run; this script is what turns "the test is green" into a number a
 * human (or `docs/PLAN.md`'s gate) can read without re-running vitest.
 *
 * Deliberately independent of `packages/caption-styles/parity/results.json`
 * (the style parity gate, A18a) — this WP's own file, never touching that
 * one, exactly as its own README explains.
 *
 * Run: `pnpm --filter @montaj/render parity`.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sampleCropWindow, type CropKeyframe } from "@montaj/render-core";

import {
  CROP_PARITY_FIXTURES,
  SOURCE_HEIGHT,
  SOURCE_WIDTH,
  type CropFixture,
} from "./crop-fixtures.js";
import { evalCropExpr, extractCropField } from "./expr-eval.js";
import { buildDynamicCropFilter } from "../src/ffmpeg/crop-expr.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, "results.json");

interface RectPx {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function cloudRectPx(
  keyframes: readonly CropKeyframe[],
  sourceWidth: number,
  sourceHeight: number,
  tSec: number,
): RectPx {
  const filter = buildDynamicCropFilter(keyframes, sourceWidth, sourceHeight);
  if (filter === null) throw new Error("expected a crop filter for this fixture");
  return {
    x: evalCropExpr(extractCropField(filter, "x"), tSec),
    y: evalCropExpr(extractCropField(filter, "y"), tSec),
    w: evalCropExpr(extractCropField(filter, "w"), tSec),
    h: evalCropExpr(extractCropField(filter, "h"), tSec),
  };
}

function browserRectPx(
  keyframes: readonly CropKeyframe[],
  sourceWidth: number,
  sourceHeight: number,
  tSec: number,
): RectPx {
  const rect = sampleCropWindow(keyframes, tSec * 1_000);
  if (rect === null) throw new Error("expected a crop window for this fixture");
  return {
    x: rect.x * sourceWidth,
    y: rect.y * sourceHeight,
    w: rect.w * sourceWidth,
    h: rect.h * sourceHeight,
  };
}

function maxAbsDiffPx(a: RectPx, b: RectPx): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.w - b.w),
    Math.abs(a.h - b.h),
  );
}

/** The tolerance `crop-parity.test.ts` holds every sample to (its own `tolerancePx`, plus 1px rounding slack). */
export const MAX_DIFF_PX_TOLERANCE = 1.05;

interface FixtureResult {
  readonly fixtureId: string;
  readonly label: string;
  readonly samples: number;
  readonly maxDiffPx: number;
  readonly pass: boolean;
  readonly measuredAt: string;
}

function measureFixture(fixture: CropFixture, now: string): FixtureResult {
  let maxDiffPx = 0;
  for (const tSec of fixture.sampleAtSec) {
    const browser = browserRectPx(fixture.keyframes, SOURCE_WIDTH, SOURCE_HEIGHT, tSec);
    const cloud = cloudRectPx(fixture.keyframes, SOURCE_WIDTH, SOURCE_HEIGHT, tSec);
    maxDiffPx = Math.max(maxDiffPx, maxAbsDiffPx(browser, cloud));
  }
  return {
    fixtureId: fixture.id,
    label: fixture.label,
    samples: fixture.sampleAtSec.length,
    maxDiffPx,
    pass: maxDiffPx <= MAX_DIFF_PX_TOLERANCE,
    measuredAt: now,
  };
}

export function measureAll(now: string = new Date().toISOString()): {
  generatedAt: string;
  maxDiffPxTolerance: number;
  sourceWidth: number;
  sourceHeight: number;
  edits: Record<string, FixtureResult>;
} {
  const edits: Record<string, FixtureResult> = {};
  for (const fixture of CROP_PARITY_FIXTURES) edits[fixture.id] = measureFixture(fixture, now);
  return {
    generatedAt: now,
    maxDiffPxTolerance: MAX_DIFF_PX_TOLERANCE,
    sourceWidth: SOURCE_WIDTH,
    sourceHeight: SOURCE_HEIGHT,
    edits,
  };
}

async function main(): Promise<void> {
  const output = measureAll();
  await writeFile(RESULTS_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  const failed = Object.values(output.edits).filter((result) => !result.pass);
  for (const result of Object.values(output.edits)) {
    console.error(
      `${result.pass ? "PASS" : "FAIL"} ${result.fixtureId}: max diff ${result.maxDiffPx.toFixed(3)}px ` +
        `over ${String(result.samples)} samples (tolerance ${String(MAX_DIFF_PX_TOLERANCE)}px)`,
    );
  }
  if (failed.length > 0) {
    console.error(`${String(failed.length)} crop-parity fixture(s) exceeded tolerance.`);
    process.exitCode = 1;
  }
}

// Script entry point — not when `measureAll`/`main` are merely imported by a test.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("parity/run.ts") === true) {
  void main();
}
