import { describe, expect, it } from "vitest";

import { buildTimeMap } from "./timemap.js";

import type { CutEdit } from "./edits.js";

/**
 * The performance floor from the brief: 5,000 cuts on a six-hour source, and
 * 100,000 `toOutput` lookups in under 100 ms.
 *
 * The absolute budget is the headline, but it is measured against a **flat** map
 * (one span, so one probe) in the same run and allowed to scale with it. That
 * keeps the test honest under coverage instrumentation or on a slow CI box while
 * still failing hard on a regression to a linear scan, which would cost
 * thousands of times the flat map rather than a small multiple of it.
 * `src/search.test.ts` counts the probes to prove `O(log n)` deterministically.
 */

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const CUT_COUNT = 5000;
const LOOKUPS = 100_000;
const BUDGET_MS = 100;
/** How much dearer a 10,001-span lookup may be than a 1-span lookup. */
const SPAN_OVERHEAD_ALLOWANCE = 8;

/** 5,000 evenly spread half-second cuts — one silence trimmed every four seconds. */
function manyCuts(): CutEdit[] {
  const stride = Math.floor(SIX_HOURS_MS / CUT_COUNT);
  return Array.from({ length: CUT_COUNT }, (_unused, index) => ({
    kind: "cut" as const,
    startMs: index * stride + 1000,
    endMs: index * stride + 1500,
  }));
}

/** Deterministic pseudo-random source instants, so runs are comparable. */
function probes(count: number, max: number): number[] {
  const out = new Array<number>(count);
  let state = 0x9e3779b9;
  for (let i = 0; i < count; i += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    out[i] = state % max;
  }
  return out;
}

/** Runs `lookup` over every point, after a warm-up, and returns the milliseconds taken. */
function time(points: readonly number[], lookup: (ms: number) => number): number {
  let sink = 0;
  for (let i = 0; i < 10_000; i += 1) sink += lookup(points[i] as number);
  const started = performance.now();
  for (let i = 0; i < points.length; i += 1) sink += lookup(points[i] as number);
  const elapsed = performance.now() - started;
  if (sink < 0) throw new Error("unreachable; keeps the loop from being optimised away");
  return elapsed;
}

describe("benchmark", () => {
  const map = buildTimeMap({ sourceDurationMs: SIX_HOURS_MS, edits: manyCuts() });
  const flat = buildTimeMap({ sourceDurationMs: SIX_HOURS_MS });
  const points = probes(LOOKUPS, SIX_HOURS_MS);

  it("builds a 5,000-cut, six-hour map into 10,001 spans", () => {
    expect(map.cuts).toHaveLength(CUT_COUNT);
    expect(map.spans).toHaveLength(2 * CUT_COUNT + 1);
    expect(map.outputDurationMs).toBe(SIX_HOURS_MS - CUT_COUNT * 500);
    expect(flat.spans).toHaveLength(1);
  });

  it(`answers ${LOOKUPS.toLocaleString("en")} toOutput lookups in under ${BUDGET_MS} ms`, () => {
    const baseline = time(points, (ms) => flat.toOutput(ms) ?? 0);
    const elapsed = time(points, (ms) => map.toOutput(ms) ?? 0);
    console.warn(
      `toOutput: ${LOOKUPS} lookups over ${map.spans.length} spans in ${elapsed.toFixed(1)} ms ` +
        `(1 span: ${baseline.toFixed(1)} ms)`,
    );
    expect(elapsed).toBeLessThan(Math.max(BUDGET_MS, baseline * SPAN_OVERHEAD_ALLOWANCE));
  });

  it(`answers ${LOOKUPS.toLocaleString("en")} toSource lookups in under ${BUDGET_MS} ms`, () => {
    const outputs = probes(LOOKUPS, map.outputDurationMs);
    const baseline = time(outputs, (ms) => flat.toSource(ms));
    const elapsed = time(outputs, (ms) => map.toSource(ms));
    console.warn(
      `toSource: ${LOOKUPS} lookups over ${map.spans.length} spans in ${elapsed.toFixed(1)} ms ` +
        `(1 span: ${baseline.toFixed(1)} ms)`,
    );
    expect(elapsed).toBeLessThan(Math.max(BUDGET_MS, baseline * SPAN_OVERHEAD_ALLOWANCE));
  });

  it("builds the map itself in linear time", () => {
    const edits = manyCuts();
    const started = performance.now();
    buildTimeMap({ sourceDurationMs: SIX_HOURS_MS, edits });
    const elapsed = performance.now() - started;
    console.warn(`buildTimeMap: ${CUT_COUNT} cuts in ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(2000);
  });
});
