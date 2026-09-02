import { BILLING_QUANTUM_MS, creditCostTenths, deciMinutes, formatCredits } from "@montaj/config";

/**
 * What an `ai.clean` run costs (CONTRACTS §4, `packages/config/src/credits.ts`
 * `audioClean`): 1 credit per media minute on the 48 kHz path, rounded up to
 * 0.1 of a minute, `creator` plan and above. `note: "Local is free."` describes
 * the desktop engine (C03b) reusing the same DSP parameters — out of scope here
 * (brief "Out of scope") — so every quote this module produces is the cloud rate.
 *
 * Mirrors `transcripts/transcripts.quote.ts` exactly: the burn rate lives in one
 * place, this module only decides which duration to multiply it by.
 */
export interface AudioCleanQuote {
  readonly durationMs: number;
  readonly deciMinutes: number;
  readonly tenths: number;
  readonly credits: string;
  readonly reason: string;
}

/**
 * Quote a clean of `durationMs` of media.
 *
 * @throws RangeError when the duration is not finite and non-negative — the
 * caller skipped the "is the media probed?" check.
 */
export function quoteAudioClean(durationMs: number): AudioCleanQuote {
  const units = deciMinutes(durationMs);
  const tenths = creditCostTenths({ operation: "audioClean", durationMs });
  const minutes = (units * BILLING_QUANTUM_MS) / 60_000;

  return {
    durationMs,
    deciMinutes: units,
    tenths,
    credits: formatCredits(tenths),
    reason: `ai.clean · ${minutes.toFixed(1)} media minutes`,
  };
}

/**
 * What to settle once the worker reports what it actually processed.
 * `usage.mediaSeconds` may never raise the charge above the hold.
 */
export function settlementFor(quote: AudioCleanQuote, mediaSeconds?: number): number {
  if (mediaSeconds === undefined || !Number.isFinite(mediaSeconds) || mediaSeconds < 0) {
    return quote.tenths;
  }
  const actual = creditCostTenths({ operation: "audioClean", durationMs: mediaSeconds * 1_000 });
  return Math.min(quote.tenths, actual);
}
