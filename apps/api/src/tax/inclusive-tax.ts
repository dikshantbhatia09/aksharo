/**
 * Rule 35 (CGST Rules) back-computation: prices are shown **inclusive** of GST
 * (`04-pricing-and-monetization.md` v2 §Tax, s.33 CGST — the tax amount must be
 * prominently indicated), so the taxable value and the tax itself are derived
 * from the tax-inclusive total, not the other way round.
 *
 * Rule 35's formula: `tax amount = (value inclusive of tax × tax rate) /
 * (100 + tax rate)`. Everything here is integer minor-unit arithmetic —
 * money never touches a float — with explicit, deterministic rounding, per the
 * brief's `roundOffMinor`.
 */

export interface InclusiveTaxBreakdown {
  /** The tax-inclusive amount this breakdown was computed from (post-discount). */
  readonly totalMinor: number;
  /** Value of supply, ex-tax (Rule 35). */
  readonly taxableValueMinor: number;
  /** CGST + SGST + IGST + cess combined. */
  readonly totalTaxMinor: number;
  /** Half of `totalTaxMinor`, rounded down; zero for inter-state/export/RCM. */
  readonly cgstMinor: number;
  /** The remainder after `cgstMinor`, so `cgstMinor + sgstMinor === totalTaxMinor` exactly. */
  readonly sgstMinor: number;
  /** The whole `totalTaxMinor` for an inter-state supply; zero otherwise. */
  readonly igstMinor: number;
  /**
   * `totalMinor - (taxableValueMinor + totalTaxMinor)`.
   *
   * Zero by construction here (the taxable value is defined as what is left
   * over after the tax amount, so the three always sum back to the total) —
   * computed explicitly rather than hard-coded to `0` so a future line-item
   * split (summing several taxable values that each round independently)
   * cannot silently drop a paisa without a visible, reconciled field.
   */
  readonly roundOffMinor: number;
}

/**
 * Round to the nearest integer minor unit, half away from zero — the
 * conventional rupee/cent rounding rule and the one every other money helper
 * in this codebase (`billing/money.ts`) implicitly relies on for `Math.round`
 * on positive amounts. Written out because Rule 35's tax amount can land
 * exactly on a half-paisa (e.g. an odd total at 18%).
 */
export function roundMinor(value: number): number {
  return value >= 0 ? Math.round(value) : -Math.round(-value);
}

/**
 * Back-compute the Rule 35 breakdown of a GST-inclusive amount.
 *
 * `rateBps` is the COMBINED rate (1800 = 18%, split CGST 900 + SGST 900 for
 * `intraState: true`, or the whole 1800 as IGST otherwise); `0` for export,
 * SEZ and any other zero-rated supply, in which case the total minor amount
 * IS the taxable value and every tax component is zero.
 */
export function backComputeInclusive(
  totalMinor: number,
  rateBps: number,
  intraState: boolean,
): InclusiveTaxBreakdown {
  if (!Number.isInteger(totalMinor) || totalMinor < 0) {
    throw new RangeError("totalMinor must be a non-negative integer (minor units).");
  }
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new RangeError("rateBps must be a non-negative integer.");
  }

  if (rateBps === 0) {
    return {
      totalMinor,
      taxableValueMinor: totalMinor,
      totalTaxMinor: 0,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 0,
      roundOffMinor: 0,
    };
  }

  // Rule 35: tax = (inclusive value × rate) / (100 + rate), in basis points:
  // tax = total × rateBps / (10_000 + rateBps).
  const totalTaxMinor = roundMinor((totalMinor * rateBps) / (10_000 + rateBps));
  const taxableValueMinor = totalMinor - totalTaxMinor;

  const cgstMinor = intraState ? Math.floor(totalTaxMinor / 2) : 0;
  const sgstMinor = intraState ? totalTaxMinor - cgstMinor : 0;
  const igstMinor = intraState ? 0 : totalTaxMinor;

  const roundOffMinor = totalMinor - (taxableValueMinor + cgstMinor + sgstMinor + igstMinor);

  return {
    totalMinor,
    taxableValueMinor,
    totalTaxMinor,
    cgstMinor,
    sgstMinor,
    igstMinor,
    roundOffMinor,
  };
}
