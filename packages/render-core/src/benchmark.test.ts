/**
 * The per-frame budget.
 *
 * The target is **< 2 ms** to lay out and draw a two-line caption at 1080p on
 * Node; the assertion uses a generous CI bound of 10 ms so a loaded shared
 * runner cannot turn a performance target into a flaky build. The measured
 * median is printed on every run, which is what a reviewer should read.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";

import { animate } from "./animate/animate.js";
import { countCommands } from "./commands/types.js";
import { type Shaper } from "./fonts/shaper.js";
import { type FontRegistry } from "./fonts/types.js";
import { layoutSegment } from "./layout/layout.js";
import { type RenderWord } from "./layout/types.js";
import { CAPTION_FIXTURES, createFixtureRenderer, GOLDEN_CANVAS } from "./testing.js";

/** Generous CI bound; the design target is 2 ms. */
const BUDGET_MS = 10;

/**
 * Wall-clock allowance, not a performance bound — that is `BUDGET_MS`, asserted
 * on the median. `turbo` runs every package's suite at once, so on a busy
 * machine these loops get a fraction of a core and take far longer than the work
 * in them; the default 15 s timeout then fails a test that is measuring
 * correctly. The p50 assertion is what guards performance.
 */
const MEASUREMENT_TIMEOUT_MS = 120_000;
const TARGET_MS = 2;
const ITERATIONS = 300;

let registry: FontRegistry;
let shaper: Shaper;

beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
});

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function timeFrames(
  styleId: string,
  words: readonly RenderWord[],
  iterations = ITERATIONS,
): number[] {
  const style = loadSystemStyleMap().get(styleId);
  if (style === undefined) throw new Error(`no style ${styleId}`);
  const segment = { id: "bench", startMs: 0, endMs: 3000 };
  const samples: number[] = [];
  // Warm the shaping cache first: a cold cache measures HarfBuzz, not layout.
  for (let i = 0; i < 30; i += 1) {
    animate({
      layout: layoutSegment({
        style,
        segment,
        words,
        canvas: GOLDEN_CANVAS,
        registry,
        shaper,
        tMs: i,
      }),
      style,
      tMs: i,
    });
  }
  for (let i = 0; i < iterations; i += 1) {
    const tMs = 100 + (i % 2800);
    const started = performance.now();
    const layout = layoutSegment({
      style,
      segment,
      words,
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      tMs,
    });
    animate({ layout, style, tMs });
    samples.push(performance.now() - started);
  }
  return samples;
}

describe("per-frame budget", () => {
  const twoLines: RenderWord[] = [
    "Bhai",
    "aaj",
    "hum",
    "video",
    "editing",
    "ke",
    "bare",
    "mein",
    "baat",
    "karenge",
  ].map((t, index) => ({ wid: `0:${String(index)}`, t, s: index * 300, e: (index + 1) * 300 }));

  it(
    "lays out and draws a two-line caption well inside the CI bound",
    { timeout: MEASUREMENT_TIMEOUT_MS },
    () => {
      const samples = timeFrames("vertical-clean", twoLines);
      const p50 = median(samples);
      const p95 = percentile(samples, 0.95);
      console.log(
        `render-core two-line 1080p frame: p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms (target ${String(TARGET_MS)} ms, CI bound ${String(BUDGET_MS)} ms)`,
      );
      expect(p50).toBeLessThan(BUDGET_MS);
    },
  );

  it(
    "stays inside the bound for every script and for the heaviest styles",
    { timeout: MEASUREMENT_TIMEOUT_MS },
    () => {
      for (const fixture of CAPTION_FIXTURES) {
        for (const styleId of ["punch-pop", "karaoke-fill", "glitch-shift", "liquid-glass"]) {
          const p50 = median(timeFrames(styleId, fixture.words, 60));
          console.log(`  ${styleId}/${fixture.name}: p50 ${p50.toFixed(3)} ms`);
          expect(p50, `${styleId}/${fixture.name}`).toBeLessThan(BUDGET_MS);
        }
      }
    },
  );

  it("keeps a caption's command list small enough to ship to a worker", () => {
    const style = loadSystemStyleMap().get("punch-pop");
    if (style === undefined) throw new Error("no style");
    const layout = layoutSegment({
      style,
      segment: { id: "bench", startMs: 0, endMs: 3000 },
      words: twoLines,
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      tMs: 1500,
    });
    const commands = animate({ layout, style, tMs: 1500 });
    expect(countCommands(commands)).toBeLessThan(200);
    expect(JSON.stringify(commands).length).toBeLessThan(60_000);
  });
});
