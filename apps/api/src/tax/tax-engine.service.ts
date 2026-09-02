import { Inject, Injectable } from "@nestjs/common";

import { EXCHANGE_RATE_PROVIDER, type ExchangeRateProvider } from "./exchange-rate.js";
import { backComputeInclusive } from "./inclusive-tax.js";
import { determinePlaceOfSupply } from "./place-of-supply.js";
import {
  IGST_RATE_BPS,
  LUT_EXPORT_ENDORSEMENT,
  STANDARD_GST_RATE_BPS,
  ZERO_RATE_BPS,
} from "./tax.constants.js";

import type { $Enums } from "@prisma/client";

/**
 * The tax engine (brief §1): place of supply, intra/inter/export/RCM rate
 * selection, Rule 35 inclusive back-computation and (for USD) the exchange
 * rate — combined into the one breakdown an invoice is built from.
 */

export interface ComputeTaxInput {
  /** The GST-inclusive amount actually charged/received, in `currency`. */
  readonly totalMinor: number;
  readonly currency: $Enums.Currency;
  /** Informational only — the taxable value is always derived from `totalMinor` (Rule 35). */
  readonly discountMinor?: number;
  readonly couponCode?: string | undefined;
  readonly recipientCountry: string;
  readonly recipientGstin?: string | null | undefined;
  readonly recipientStateCode?: string | null | undefined;
  readonly supplierStateCode: string;
  readonly isImportOfService?: boolean;
  readonly isSez?: boolean;
  /** Defaults to `now`. */
  readonly exchangeRateAt?: Date;
}

export interface TaxComputation {
  readonly supplyType: $Enums.SupplyType;
  readonly placeOfSupplyStateCode: string | null;
  readonly placeOfSupplyCountry: string;
  readonly reverseCharge: boolean;
  readonly taxRateBps: number;
  readonly taxableValueMinor: number;
  readonly discountMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  readonly cessMinor: number;
  readonly totalTaxMinor: number;
  readonly totalMinor: number;
  readonly roundOffMinor: number;
  readonly exchangeRateToInr: number | null;
  readonly exchangeRateAt: Date | null;
  /** Set only for `supplyType === "export"` (D41, RR-05 E2). */
  readonly exportEndorsementText: string | null;
}

export type TaxComputationProblem = "gstin_malformed" | "state_required";

export type TaxComputationOutcome =
  | { readonly ok: true; readonly computation: TaxComputation }
  | { readonly ok: false; readonly problem: TaxComputationProblem; readonly message: string };

@Injectable()
export class TaxEngineService {
  constructor(
    @Inject(EXCHANGE_RATE_PROVIDER) private readonly exchangeRates: ExchangeRateProvider,
  ) {}

  async compute(input: ComputeTaxInput): Promise<TaxComputationOutcome> {
    const placeOfSupply = determinePlaceOfSupply({
      recipientCountry: input.recipientCountry,
      recipientGstin: input.recipientGstin,
      recipientStateCode: input.recipientStateCode,
      supplierStateCode: input.supplierStateCode,
      isImportOfService: input.isImportOfService ?? false,
      isSez: input.isSez ?? false,
    });
    if (!placeOfSupply.ok) {
      return { ok: false, problem: placeOfSupply.problem, message: placeOfSupply.message };
    }
    const { supplyType, stateCode, country, reverseCharge } = placeOfSupply.result;

    const taxRateBps =
      supplyType === "intra_state"
        ? STANDARD_GST_RATE_BPS
        : supplyType === "inter_state"
          ? IGST_RATE_BPS
          : ZERO_RATE_BPS; // export | sez | import_rcm: zero-rated / RCM (no output tax)

    const breakdown = backComputeInclusive(
      input.totalMinor,
      taxRateBps,
      supplyType === "intra_state",
    );

    let exchangeRateToInr: number | null = null;
    let exchangeRateAt: Date | null = null;
    if (input.currency === "USD") {
      const quote = await this.exchangeRates.getUsdToInrRate(input.exchangeRateAt ?? new Date());
      exchangeRateToInr = quote.rate;
      exchangeRateAt = quote.asOf;
    }

    return {
      ok: true,
      computation: {
        supplyType,
        placeOfSupplyStateCode: stateCode,
        placeOfSupplyCountry: country,
        reverseCharge,
        taxRateBps,
        taxableValueMinor: breakdown.taxableValueMinor,
        discountMinor: input.discountMinor ?? 0,
        cgstMinor: breakdown.cgstMinor,
        sgstMinor: breakdown.sgstMinor,
        igstMinor: breakdown.igstMinor,
        cessMinor: 0,
        totalTaxMinor: breakdown.totalTaxMinor,
        totalMinor: breakdown.totalMinor,
        roundOffMinor: breakdown.roundOffMinor,
        exchangeRateToInr,
        exchangeRateAt,
        exportEndorsementText: supplyType === "export" ? LUT_EXPORT_ENDORSEMENT : null,
      },
    };
  }
}
