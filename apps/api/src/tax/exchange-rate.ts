/**
 * USD → INR exchange rate for a USD invoice's `exchangeRateToInr`/
 * `exchangeRateAt` (brief §1: "from a configurable rate source (daily RBI
 * reference rate fetch behind an interface; fallback to a manual table)").
 *
 * There is no live RBI feed key or endpoint available in this environment —
 * exactly the position `billing/providers/provider.factory.ts` documents for
 * Razorpay — so `createExchangeRateProvider` always returns
 * {@link ManualFallbackExchangeRateProvider} today. The interface is the
 * pluggable seam: a `RbiReferenceRateProvider` implementing
 * {@link ExchangeRateProvider} against the real RBI reference-rate feed is a
 * drop-in replacement with no caller change, the same cutover story
 * `RAZORPAY_KEY_ID` gives `createBillingProvider`.
 */

export const EXCHANGE_RATE_PROVIDER = Symbol("MONTAJ_EXCHANGE_RATE_PROVIDER");

export interface ExchangeRateQuote {
  /** INR per 1 USD. */
  readonly rate: number;
  /** The date this rate is dated to (the fallback table's effective date, or the fetch date). */
  readonly asOf: Date;
  readonly source: "manual_table" | "rbi_reference_rate";
}

export interface ExchangeRateProvider {
  /** INR per 1 USD, as of `date` (or the closest prior published rate). */
  getUsdToInrRate(date: Date): Promise<ExchangeRateQuote>;
}

/**
 * A manually-maintained table of effective-from dates and rates.
 *
 * **[CA/Finance]** These are illustrative, order-of-magnitude figures, not a
 * live feed — flagged for the accountant/finance owner to keep current (or to
 * replace with the real RBI reference-rate integration) before any USD
 * invoice is treated as final for filing. `getUsdToInrRate` always returns the
 * latest entry whose `effectiveFrom` is on or before the requested date, so a
 * new row can be appended without touching old invoices' already-stamped rate.
 */
export const FALLBACK_USD_INR_TABLE: readonly { effectiveFrom: Date; rate: number }[] = [
  { effectiveFrom: new Date("2025-01-01T00:00:00.000Z"), rate: 85.5 },
  { effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), rate: 87.0 },
  { effectiveFrom: new Date("2026-07-01T00:00:00.000Z"), rate: 88.0 },
];

export class ManualFallbackExchangeRateProvider implements ExchangeRateProvider {
  constructor(
    private readonly table: readonly {
      effectiveFrom: Date;
      rate: number;
    }[] = FALLBACK_USD_INR_TABLE,
  ) {}

  async getUsdToInrRate(date: Date): Promise<ExchangeRateQuote> {
    const sorted = [...this.table].sort(
      (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
    );
    let chosen = sorted[0];
    for (const row of sorted) {
      if (row.effectiveFrom.getTime() <= date.getTime()) chosen = row;
      else break;
    }
    if (chosen === undefined) {
      throw new Error("No fallback exchange rate is configured.");
    }
    return { rate: chosen.rate, asOf: chosen.effectiveFrom, source: "manual_table" };
  }
}

/**
 * `RAZORPAY_KEY_ID`-style cutover point. No live RBI credentials exist in this
 * environment (see module docstring), so this always returns the manual
 * fallback today; wiring a real daily fetch here is the entire cutover.
 */
export function createExchangeRateProvider(): ExchangeRateProvider {
  return new ManualFallbackExchangeRateProvider();
}
