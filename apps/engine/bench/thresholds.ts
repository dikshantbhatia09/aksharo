import type { LatencyTier } from "@montaj/engine-client";

/**
 * The C03b quality-gate thresholds (`03-architecture/05-system-architecture.md`
 * §7): median word-boundary error <= 80ms vs. the cloud aligner on the
 * Hinglish fixture, a WER band (fixture default recorded here until A00-05's
 * real target lands), and per-tier wall-clock latency on a 5-minute clip (tier
 * D: local engine disabled, so there is no latency bar for it). Pure,
 * dependency-free functions so they are unit-testable without a server, a
 * fixture file or a Python process — `run.ts` is the only thing that wires
 * them to a real harness run.
 */

export interface QualityGateConfig {
  /** `05-system-architecture.md` §7: "median word-boundary error <= 80ms". */
  readonly maxMedianBoundaryErrorMs: number;
  /**
   * WER band: `[min, max]`, inclusive. `05-system-architecture.md` §7 leaves the
   * exact number to A00-05's real targets ("from A00-05 targets once known");
   * until then this is the fixture's own recorded default, wide enough that a
   * plumbing run against `FakeBackend` (a hand-written fixture, not a real ASR
   * system) does not itself fail the gate for reasons that have nothing to do
   * with alignment quality.
   */
  readonly werBand: readonly [number, number];
  /** Tier -> max wall-clock seconds for the 5-minute-clip benchmark. Tier D has no entry: local is disabled. */
  readonly latencyTierMaxS: Partial<Record<LatencyTier, number>>;
}

export const defaultQualityGateConfig: QualityGateConfig = {
  maxMedianBoundaryErrorMs: 80,
  werBand: [0, 0.25],
  latencyTierMaxS: { A: 60, B: 90, C: 120 },
};

export type ThresholdVerdict = "pass" | "fail" | "not-applicable";

export interface ThresholdResult {
  readonly verdict: ThresholdVerdict;
  readonly detail: string;
}

/** `not-applicable` when there is no boundary-error figure at all (e.g. mismatched word counts — `median_onset_error_ms` returned `None`). */
export function evaluateBoundaryError(
  medianErrorMs: number | null,
  config: QualityGateConfig = defaultQualityGateConfig,
): ThresholdResult {
  if (medianErrorMs === null) {
    return {
      verdict: "not-applicable",
      detail: "no median boundary error (reference/hypothesis word counts differ)",
    };
  }
  const pass = medianErrorMs <= config.maxMedianBoundaryErrorMs;
  return {
    verdict: pass ? "pass" : "fail",
    detail: `median boundary error ${medianErrorMs.toFixed(1)}ms (bar: <=${String(config.maxMedianBoundaryErrorMs)}ms)`,
  };
}

export function evaluateWer(
  wer: number,
  config: QualityGateConfig = defaultQualityGateConfig,
): ThresholdResult {
  const [min, max] = config.werBand;
  const pass = wer >= min && wer <= max;
  return {
    verdict: pass ? "pass" : "fail",
    detail: `WER ${wer.toFixed(4)} (band: [${min.toFixed(2)}, ${max.toFixed(2)}])`,
  };
}

/** `not-applicable` for tier D (local engine disabled, brief §7) or a tier with no configured bar. */
export function evaluateLatency(
  tier: LatencyTier,
  wallClockS: number,
  config: QualityGateConfig = defaultQualityGateConfig,
): ThresholdResult {
  const maxS = config.latencyTierMaxS[tier];
  if (maxS === undefined) {
    return {
      verdict: "not-applicable",
      detail: `tier ${tier} has no latency bar (local disabled)`,
    };
  }
  const pass = wallClockS <= maxS;
  return {
    verdict: pass ? "pass" : "fail",
    detail: `tier ${tier}: ${wallClockS.toFixed(1)}s (bar: <=${String(maxS)}s)`,
  };
}

/** Tier mismatch check (brief scope item 3): the harness's own detection vs. the server's reported `/health` tier. */
export function evaluateTierMatch(expected: LatencyTier, reported: LatencyTier): ThresholdResult {
  const pass = expected === reported;
  return {
    verdict: pass ? "pass" : "fail",
    detail: pass
      ? `tier ${reported} matches the harness's own detection`
      : `tier mismatch: harness detected ${expected}, server reported ${reported}`,
  };
}

/** Overall pass: every individual verdict is `pass` or `not-applicable` (never `fail`), and at least one is a real `pass`. */
export function overallVerdict(results: readonly ThresholdResult[]): ThresholdVerdict {
  if (results.some((r) => r.verdict === "fail")) return "fail";
  if (results.some((r) => r.verdict === "pass")) return "pass";
  return "not-applicable";
}
