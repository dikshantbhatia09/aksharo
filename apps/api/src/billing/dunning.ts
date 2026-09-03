/**
 * The dunning ladder (B01 brief §7): "each decline code distinctly, fallback
 * offer: card/eNACH/pay-once."
 *
 * Pure classification, asserted without a database — same reasoning as
 * `money.ts`. Razorpay's exact recurring-payment decline vocabulary could not
 * be confirmed without a live account (README open questions), so codes are
 * matched by **substring** against the buckets RR-05 and the RBI framework
 * describe, rather than an exhaustive enum that would silently miss a real
 * code spelled slightly differently. Buckets, worst news first:
 *
 * - **mandate**: the mandate itself is gone (`india_recurring_payment_mandate_
 *   canceled` — RR-05 C4). Retrying is pointless; the customer must re-register.
 * - **card**: the instrument is the problem (expired, invalid). Retrying the
 *   same card is pointless; offer a fallback rail immediately.
 * - **insufficient_funds**: a soft decline — RR-05 A9's ~30% UPI Autopay
 *   success rate is largely this. Worth a short retry ladder.
 * - **generic**: `transaction_not_approved`/`do_not_honor` and anything else —
 *   a longer retry ladder before giving up (RR-05 C4's three named codes).
 */

export type DeclineBucket = "mandate" | "card" | "insufficient_funds" | "generic";

export interface DunningStep {
  readonly bucket: DeclineBucket;
  /** `retry` tries the same mandate again later; `offer_fallback` stops retrying now. */
  readonly action: "retry" | "offer_fallback";
  /** Delay before the next attempt, in ms. Absent when the action is not `retry`. */
  readonly retryDelayMs?: number;
  readonly maxAttempts: number;
  /** `true` once `attemptNo` has reached `maxAttempts` for this bucket. */
  readonly exhausted: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Bucket, in priority order — the first substring match wins. */
const PATTERNS: readonly { readonly bucket: DeclineBucket; readonly test: RegExp }[] = [
  { bucket: "mandate", test: /mandate/i },
  { bucket: "card", test: /card|expired|invalid_card/i },
  { bucket: "insufficient_funds", test: /insufficient/i },
];

const LADDER: Record<DeclineBucket, Omit<DunningStep, "exhausted" | "bucket">> = {
  mandate: { action: "offer_fallback", maxAttempts: 1 },
  card: { action: "offer_fallback", maxAttempts: 1 },
  insufficient_funds: { action: "retry", retryDelayMs: DAY_MS, maxAttempts: 3 },
  generic: { action: "retry", retryDelayMs: 2 * DAY_MS, maxAttempts: 3 },
};

export function classifyDecline(code: string | undefined | null, attemptNo: number): DunningStep {
  const bucket =
    code === undefined || code === null
      ? "generic"
      : (PATTERNS.find((pattern) => pattern.test.test(code))?.bucket ?? "generic");

  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const rung = LADDER[bucket];
  // A bucket whose base action is already `offer_fallback` (mandate, card) has
  // no retry step at all — it is "exhausted" from the first decline, not only
  // after `maxAttempts` failed attempts, which `attemptNo >= maxAttempts` alone
  // would not say for `attemptNo: 0`.
  const exhausted = rung.action === "offer_fallback" || attemptNo >= rung.maxAttempts;
  return {
    bucket,
    exhausted,
    action: exhausted ? "offer_fallback" : rung.action,
    maxAttempts: rung.maxAttempts,
    ...(rung.retryDelayMs === undefined || exhausted ? {} : { retryDelayMs: rung.retryDelayMs }),
  };
}
