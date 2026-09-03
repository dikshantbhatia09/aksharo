#!/usr/bin/env tsx
/**
 * D04c's SFX-duck parity gate: measures the max linear-gain disagreement
 * between the browser exporter's `duckGainAt` (`apps/web/lib/export/
 * engine.ts`) and the cloud renderer's `buildSfxDuckVolumeExpr` (`../src/
 * ffmpeg/sfx-duck-expr.ts`) over a representative set of accepted `sfx`
 * items' own `duck` curves (CONTRACTS §2's `SfxPayload.duck`), and writes
 * `results.json`'s `sfx` block — turning `./sfx-parity.test.ts`'s already-
 * green generic check into a number a human (or `docs/PLAN.md`'s D33 gate)
 * can read without re-running vitest.
 *
 * Deliberately independent of `packages/caption-styles/parity/results.json`
 * (A18a) and of `run.ts`'s own `edits` key (B20b) — this script reads the
 * file first and only replaces its own `sfx` key, so running one gate never
 * erases another's last-recorded numbers (the same convention `run-audio-
 * parity.ts` follows for its own `audio` key).
 *
 * Run: `pnpm --filter @montaj/render parity:sfx`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { evalSfxDuckExpr } from "./sfx-expr-eval.js";
import { computeSfxParity, type SfxDuckCurve } from "./sfx-parity.js";
import { buildSfxDuckVolumeExpr, dbToLinear } from "../src/ffmpeg/sfx-duck-expr.js";

const RESULTS_PATH = join(__dirname, "results.json");

interface SpeechRange {
  readonly startMs: number;
  readonly endMs: number;
}

/** A faithful re-implementation of `apps/web/lib/export/engine.ts`'s
 * `duckGainAt` trapezoid — apps do not import one another in this monorepo
 * (only `packages/*` are shared), so this is the browser path's own
 * arithmetic, standing in for the module this gate cannot import directly. */
function browserDuckGainAt(
  tMs: number,
  speechRanges: readonly SpeechRange[],
  duckDb: number,
  rampMs: number,
): number {
  const duckedGain = dbToLinear(duckDb);
  let deepest = 1;
  for (const range of speechRanges) {
    const outerStart = range.startMs - rampMs;
    const outerEnd = range.endMs + rampMs;
    if (tMs < outerStart || tMs > outerEnd) continue;
    const distanceIn = Math.max(0, Math.min(tMs - outerStart, outerEnd - tMs));
    const depth = Math.min(1, distanceIn / (2 * rampMs));
    deepest = Math.min(deepest, 1 + depth * (duckedGain - 1));
  }
  return deepest;
}

/** Representative accepted `sfx` items' `duck` curves (CONTRACTS §2). */
interface SfxDuckFixture {
  readonly id: string;
  readonly label: string;
  readonly speechRanges: readonly SpeechRange[];
  readonly depthDb: number;
  readonly attackMs: number;
  readonly releaseMs: number;
}

const SFX_DUCK_FIXTURES: readonly SfxDuckFixture[] = [
  {
    id: "default-duck",
    label: "D04a's default duck (-12dB/150ms) over one speech range",
    speechRanges: [{ startMs: 1_000, endMs: 4_000 }],
    depthDb: -12,
    attackMs: 150,
    releaseMs: 150,
  },
  {
    id: "asymmetric-ramps",
    label: "a shallower, slower-release duck over two overlapping speech ranges",
    speechRanges: [
      { startMs: 500, endMs: 2_000 },
      { startMs: 1_800, endMs: 3_200 },
    ],
    depthDb: -6,
    attackMs: 80,
    releaseMs: 400,
  },
  {
    id: "deep-duck-short-ramp",
    label: "a near-silent duck with a fast 20ms ramp",
    speechRanges: [{ startMs: 0, endMs: 1_500 }],
    depthDb: -40,
    attackMs: 20,
    releaseMs: 20,
  },
];

/** Sample instants: a dense sweep across every fixture's ranges plus ramp margins. */
function sampleTimesFor(fixture: SfxDuckFixture): number[] {
  const times = new Set<number>();
  const margin = Math.max(fixture.attackMs, fixture.releaseMs) * 2;
  for (const range of fixture.speechRanges) {
    for (let t = range.startMs - margin; t <= range.endMs + margin; t += 10) {
      times.add(Math.round(t));
    }
  }
  return [...times].sort((a, b) => a - b);
}

interface FixtureResult {
  readonly fixtureId: string;
  readonly label: string;
  readonly samples: number;
  readonly maxDiffLinear: number;
  readonly pass: boolean;
  readonly measuredAt: string;
}

/** The tolerance every sample is held to — `sfx-parity.ts`'s own default. */
export const MAX_DIFF_LINEAR_TOLERANCE = 1e-6;

function measureFixture(fixture: SfxDuckFixture, now: string): FixtureResult {
  const curve: SfxDuckCurve = {
    gainAt: (tMs) =>
      browserDuckGainAt(tMs, fixture.speechRanges, fixture.depthDb, fixture.attackMs),
  };
  const result = computeSfxParity({
    speechRanges: fixture.speechRanges,
    browserCurve: curve,
    evaluateCloudExpr: evalSfxDuckExpr,
    buildCloudExpr: (ranges) =>
      buildSfxDuckVolumeExpr(ranges, { duckDb: fixture.depthDb, rampMs: fixture.attackMs }),
    sampleTimesMs: sampleTimesFor(fixture),
    toleranceLinear: MAX_DIFF_LINEAR_TOLERANCE,
  });
  const maxDiffLinear = result.mismatches.reduce(
    (max, mismatch) => Math.max(max, mismatch.delta),
    0,
  );
  return {
    fixtureId: fixture.id,
    label: fixture.label,
    samples: result.sampleCount,
    maxDiffLinear,
    pass: result.match,
    measuredAt: now,
  };
}

export function measureAll(now: string = new Date().toISOString()): {
  generatedAt: string;
  maxDiffLinearTolerance: number;
  fixtures: Record<string, FixtureResult>;
} {
  const fixtures: Record<string, FixtureResult> = {};
  for (const fixture of SFX_DUCK_FIXTURES) fixtures[fixture.id] = measureFixture(fixture, now);
  return { generatedAt: now, maxDiffLinearTolerance: MAX_DIFF_LINEAR_TOLERANCE, fixtures };
}

/** The other keys `results.json` may already carry (`run.ts`'s `edits`, `run-audio-parity.ts`'s `audio`) — preserved verbatim. */
async function existingResults(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(RESULTS_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const output = measureAll();
  const merged = { ...(await existingResults()), sfx: output };
  await writeFile(RESULTS_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  const failed = Object.values(output.fixtures).filter((result) => !result.pass);
  for (const result of Object.values(output.fixtures)) {
    console.error(
      `${result.pass ? "PASS" : "FAIL"} ${result.fixtureId}: max diff ${result.maxDiffLinear.toExponential(3)} ` +
        `over ${String(result.samples)} samples (tolerance ${String(MAX_DIFF_LINEAR_TOLERANCE)})`,
    );
  }
  if (failed.length > 0) {
    console.error(`${String(failed.length)} sfx-duck-parity fixture(s) exceeded tolerance.`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("parity/run-sfx-parity.ts") === true) {
  void main();
}
