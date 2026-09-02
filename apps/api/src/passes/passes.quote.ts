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
