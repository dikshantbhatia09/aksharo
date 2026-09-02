import { BILLING_QUANTUM_MS, creditCostTenths, deciMinutes, formatCredits } from "@montaj/config";

/**
 * What a transcription costs, and what has to be held before it is enqueued
 * (CONTRACTS §4).
 *
 * The rate is **not** written here. `packages/config/src/credits.ts` is the one
 * place a burn rate lives — 1 credit per media minute for `transcription`, billed
 * on time rounded up to 0.1 of a minute — and this module only decides *which*
 * duration to multiply it by and how to explain the answer to a user.
 *
 * ### Worst case, and why it equals the actual case here
 *
 * `reserve` takes the worst case and `settle` takes the truth, and for most
 * operations the two differ (a prompted edit is held on source minutes and
 * settled on finished ones). Transcription is the simple case: the input duration
 * is known before the job runs, because `media.probe` measured it, and the ASR
 * cannot make the audio longer. So the hold and the settlement are the same
 * figure unless the worker reports a shorter `mediaSeconds` — which happens when
 * VAD finds trailing silence — and then the settlement is smaller and the
 * difference goes back.
 *
 * Diarisation adds nothing: `BURN_RATES.transcription` says "any language,
 * diarisation included", so asking for speakers must never change the quote.
 */

export interface TranscriptionQuote {
  /** Media duration the quote was computed from. */
  readonly durationMs: number;
  /** Billable 0.1-minute units, always rounded up. */
  readonly deciMinutes: number;
  /** Tenths of a credit to reserve. */
  readonly tenths: number;
  /** `"12.4"` — for the confirmation dialog, never for arithmetic. */
  readonly credits: string;
  /** The audit trail that goes on the hold. */
  readonly reason: string;
}

/**
 * Quote a transcription of `durationMs` of media.
 *
 * @throws RangeError when the duration is not a finite, non-negative number —
 * which means the caller skipped the "is the media probed?" check, and quoting
 * zero would silently transcribe an hour of audio for nothing.
 */
export function quoteTranscription(durationMs: number): TranscriptionQuote {
  const units = deciMinutes(durationMs);
  const tenths = creditCostTenths({ operation: "transcription", durationMs });
  const minutes = (units * BILLING_QUANTUM_MS) / 60_000;

  return {
    durationMs,
    deciMinutes: units,
    tenths,
    credits: formatCredits(tenths),
    reason: `ai.transcribe · ${minutes.toFixed(1)} media minutes`,
  };
}

/**
 * What to settle once the worker has reported what it actually consumed.
 *
 * `usage.mediaSeconds` is the duration the worker really decoded. It is never
 * allowed to *raise* the charge: a worker that reports more than was held would
 * bypass the reservation, and an over-run is B02's delta-hold problem, not a
 * producer's.
 */
export function settlementFor(quote: TranscriptionQuote, mediaSeconds?: number): number {
  if (mediaSeconds === undefined || !Number.isFinite(mediaSeconds) || mediaSeconds < 0) {
    return quote.tenths;
  }
  const actual = creditCostTenths({ operation: "transcription", durationMs: mediaSeconds * 1_000 });
  return Math.min(quote.tenths, actual);
}
