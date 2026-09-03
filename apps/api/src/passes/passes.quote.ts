import { BILLING_QUANTUM_MS, creditCostTenths, deciMinutes, formatCredits } from "@montaj/config";

/**
 * What an autocut pass costs, and what to hold before it is enqueued
 * (CONTRACTS §4).
 *
 * `packages/config/src/credits.ts` already carries `BURN_RATES.autocutPass`
 * (basis `sourceMinute`, 1 credit/min flash, 2 credits/min pro) from an earlier
 * work package; this module only decides which duration to multiply it by,
 * following `transcripts.quote.ts`'s own split between "the rate" (owned by
 * `@montaj/config`) and "which duration" (owned by the producer).
 *
 * The brief text (B18 §4) says "2 credits per media minute" — this quotes
 * against the frozen `autocutPass` flash rate (1 credit/minute) instead, since
 * `@montaj/config` is the one place a burn rate is allowed to live (CONTRACTS
 * §4) and this work package does not own it. Flagged in the final report as a
 * number to reconcile, not silently overridden here.
 */

export interface AutocutQuote {
  readonly durationMs: number;
  readonly deciMinutes: number;
  readonly tenths: number;
  readonly credits: string;
  readonly reason: string;
}

export function quoteAutocut(durationMs: number): AutocutQuote {
  const units = deciMinutes(durationMs);
  const tenths = creditCostTenths({ operation: "autocutPass", durationMs });
  const minutes = (units * BILLING_QUANTUM_MS) / 60_000;

  return {
    durationMs,
    deciMinutes: units,
    tenths,
    credits: formatCredits(tenths),
    reason: `ai.pass (autocut) · ${minutes.toFixed(1)} source minutes`,
  };
}

/**
 * What a zoom or reframe pass costs (B19 §6).
 *
 * `BURN_RATES.reframeZoomPass` (basis `sourceMinute`, 1 credit/min flash, 3
 * credits/min pro) already exists in `@montaj/config`, landed ahead of this
 * work package. This quotes against its frozen flash rate, the same split
 * `quoteAutocut` uses — B19's own brief text ("3 credits per media minute")
 * matches the *pro* rate, not flash; flagged in the final report as the same
 * kind of number-to-reconcile B18 flagged for `autocutPass`, not silently
 * overridden here.
 */
export interface ReframeZoomQuote {
  readonly durationMs: number;
  readonly deciMinutes: number;
  readonly tenths: number;
  readonly credits: string;
  readonly reason: string;
}

export function quoteReframeZoom(kind: "zoom" | "reframe", durationMs: number): ReframeZoomQuote {
  const units = deciMinutes(durationMs);
  const tenths = creditCostTenths({ operation: "reframeZoomPass", durationMs });
  const minutes = (units * BILLING_QUANTUM_MS) / 60_000;

  return {
    durationMs,
    deciMinutes: units,
    tenths,
    credits: formatCredits(tenths),
    reason: `ai.pass (${kind}) · ${minutes.toFixed(1)} source minutes`,
  };
}

/**
 * What an sfx (or music) pass costs (D04a; 09-ai-pipeline §6).
 *
 * `BURN_RATES.sfxMusicPass` (basis `finishedMinute`, 1 credit/min, Studio+
 * only — "library entitlement is carried at plan level, not per credit")
 * already exists in `@montaj/config`, landed ahead of this work package. Its
 * basis is the *finished* (post-cut) timeline, not the source, unlike
 * `autocutPass`/`reframeZoomPass` — callers pass the project's current
 * finished duration (segments minus accepted cuts), which
 * `PassesService.startSfx` reads off the EDG working set the same way it
 * reads `protectedRanges` today.
 */
export interface SfxQuote {
  readonly durationMs: number;
  readonly deciMinutes: number;
  readonly tenths: number;
  readonly credits: string;
  readonly reason: string;
}

export function quoteSfx(finishedDurationMs: number): SfxQuote {
  const units = deciMinutes(finishedDurationMs);
  const tenths = creditCostTenths({ operation: "sfxMusicPass", durationMs: finishedDurationMs });
  const minutes = (units * BILLING_QUANTUM_MS) / 60_000;

  return {
    durationMs: finishedDurationMs,
    deciMinutes: units,
    tenths,
    credits: formatCredits(tenths),
    reason: `ai.pass (sfx) · ${minutes.toFixed(1)} finished minutes`,
  };
}

/**
 * What a text-fx pass costs (D06, brief §4): `BURN_RATES.textFxPass` (basis
 * `finishedMinute`, 1 credit/min, D07 principle — a pass that reads the
 * post-cut timeline settles on it rather than the source) already lives in
 * `@montaj/config`; this only decides which duration to multiply it by.
 */
export interface TextFxQuote {
  readonly durationMs: number;
  readonly deciMinutes: number;
  readonly tenths: number;
  readonly credits: string;
  readonly reason: string;
}

export function quoteTextFx(durationMs: number): TextFxQuote {
  const units = deciMinutes(durationMs);
  const tenths = creditCostTenths({ operation: "textFxPass", durationMs });
  const minutes = (units * BILLING_QUANTUM_MS) / 60_000;

  return {
    durationMs,
    deciMinutes: units,
    tenths,
    credits: formatCredits(tenths),
    reason: `ai.pass (textfx) · ${minutes.toFixed(1)} finished minutes`,
  };
}
