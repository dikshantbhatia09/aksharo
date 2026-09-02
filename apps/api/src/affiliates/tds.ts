/**
 * TDS under s.194H (brief §4, 04 §Affiliate, `RR-05-payments-tax.md`): once an
 * affiliate's cumulative FY-to-date commission gross crosses ₹20,000, 2% TDS
 * (20% without a verified PAN) is deducted going forward. Kept as pure
 * functions so the "crossing ₹20,000 mid-year, with/without PAN" acceptance
 * test is exact arithmetic in minor units, no database.
 *
 * `affiliate_tds_section` flag: the section actually withheld is always
 * `194H` at launch (194-O is Prisma-modelled but unused) — RR-05 flags 194H
 * vs 194-O as CA-confirmed by H-18, so the flag only controls whether the
 * Form 16A stub is rendered "final" or watermarked "DRAFT — pending CA
 * confirmation of TDS section" (`form16a.ts`), never which rate is applied.
 */

export const TDS_THRESHOLD_MINOR = 2_000_000; // ₹20,000 in paise.
export const TDS_RATE_WITH_PAN_BPS = 200; // 2%
export const TDS_RATE_WITHOUT_PAN_BPS = 2000; // 20%

export interface TdsInput {
  /** This affiliate's FY-to-date gross commission *before* adding this commission. */
  readonly priorFyGrossMinor: number;
  /** This commission's own gross (excl. GST). */
  readonly grossMinor: number;
  readonly hasVerifiedPan: boolean;
}

export interface TdsResult {
  readonly newFyGrossMinor: number;
  readonly tdsRateBps: number;
  readonly tdsAmountMinor: number;
  readonly netPayableMinor: number;
  readonly crossedThresholdOnThisCommission: boolean;
}

/**
 * TDS applies to this commission only once the *running* FY total (including
 * this commission) is at or above ₹20,000 — a commission that itself crosses
 * the line is fully taxed, one that stays under it is not (194H is computed
 * per credit/payment event once the aggregate threshold condition is met,
 * never retroactively on amounts already credited before the threshold was
 * crossed).
 */
export function computeTds(input: TdsInput): TdsResult {
  const newFyGrossMinor = input.priorFyGrossMinor + input.grossMinor;
  const overThreshold = newFyGrossMinor >= TDS_THRESHOLD_MINOR;
  const crossedThresholdOnThisCommission =
    overThreshold && input.priorFyGrossMinor < TDS_THRESHOLD_MINOR;

  if (!overThreshold) {
    return {
      newFyGrossMinor,
      tdsRateBps: 0,
      tdsAmountMinor: 0,
      netPayableMinor: input.grossMinor,
      crossedThresholdOnThisCommission: false,
    };
  }

  const tdsRateBps = input.hasVerifiedPan ? TDS_RATE_WITH_PAN_BPS : TDS_RATE_WITHOUT_PAN_BPS;
  const tdsAmountMinor = Math.floor((input.grossMinor * tdsRateBps) / 10000);
  return {
    newFyGrossMinor,
    tdsRateBps,
    tdsAmountMinor,
    netPayableMinor: input.grossMinor - tdsAmountMinor,
    crossedThresholdOnThisCommission,
  };
}
