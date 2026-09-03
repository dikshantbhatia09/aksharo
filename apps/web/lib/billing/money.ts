/**
 * Pure money and mandate-display helpers for the subscription pages.
 *
 * The API is always the source of truth for what gets charged (`04
 * §Design goals` 3, and the B03 brief: "every price ... from the API, never
 * hard-coded") — nothing here invents a price. What lives here is display
 * formatting and the **client-side hint** version of the ₹15,000 UPI Autopay
 * rule (`apps/api/src/billing/money.ts`'s `decideMandate`, mirrored only for
 * instant UI feedback — disabling a doomed radio button before the round
 * trip). The server's `409 billing/mandate_cap_exceeded` (with its own
 * `alternatives`) is still handled as the authoritative outcome; see
 * `checkout-state.ts`.
 */

import type { BillingInterval, Currency, IntervalPrices } from "./types";

/** RBI's AFA-free UPI Autopay ceiling (D05/D40): ₹15,000, in paise. Mirrors
 * `apps/api/src/billing/billing.constants.ts`'s `UPI_AUTOPAY_CAP_MINOR`. */
export const UPI_AUTOPAY_CAP_MINOR = 1_500_000;

const CURRENCY_LOCALE: Record<Currency, string> = { INR: "en-IN", USD: "en-US" };

/** `amountMinor` (paise/cents) → a locale-formatted string, e.g. "₹699" or "$19". */
export function formatMoney(amountMinor: number, currency: Currency): string {
  const major = amountMinor / 100;
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  return new Intl.NumberFormat(CURRENCY_LOCALE[currency], {
    style: "currency",
    currency,
    maximumFractionDigits: major % 1 === 0 ? 0 : 2,
  }).format(major);
}

/** The per-month figure a yearly price is sold on ("2 months free" — pay 10, get 12). */
export function monthlyEquivalentMinor(prices: IntervalPrices): number {
  return Math.round(prices.year / 12);
}

/** `true` when a UPI Autopay mandate at this amount would be refused (client-side hint only). */
export function exceedsUpiAutopayCap(amountMinor: number): boolean {
  return amountMinor > UPI_AUTOPAY_CAP_MINOR;
}

/** The price for one interval, or `undefined` when the plan does not sell it (e.g. no `halfyear`). */
export function priceForInterval(
  prices: IntervalPrices,
  interval: Exclude<BillingInterval, "once">,
): number | undefined {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  return prices[interval];
}

/** "3 May 2027" — unambiguous, locale-independent enough for a billing date. */
export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** "3 May 2027, 6:00 pm" — a debit or mandate timestamp, with the hour a person reads. */
export function formatDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  }).format(date);
}

export const MANDATE_METHOD_LABEL: Record<string, string> = {
  upi_autopay: "UPI Autopay",
  card: "Card",
  enach: "eNACH",
};

const GST_RATE_BPS = 1_800;

export interface GstBreakup {
  readonly taxableValueMinor: number;
  readonly gstMinor: number;
  readonly totalMinor: number;
}

/**
 * Split a GST-inclusive INR total into taxable value and the 18% GST it
 * contains (`04 §Tax`: "prices displayed inclusive of 18% GST with a visible
 * 'incl. GST' line and the break-up"). Display-only, rounded to the rupee —
 * B05's invoice carries the authoritative CGST/SGST/IGST split once one is
 * issued; this is what the checkout confirmation step shows before that
 * exists.
 */
export function gstBreakup(totalMinor: number): GstBreakup {
  const taxableValueMinor = Math.round((totalMinor * 10_000) / (10_000 + GST_RATE_BPS));
  return { taxableValueMinor, gstMinor: totalMinor - taxableValueMinor, totalMinor };
}

/** How many billing periods a seat's price is charged for — mirrors
 * `apps/api/src/billing/money.ts`'s `SEAT_INTERVAL_FACTOR` (year pays 10 months,
 * half-year pays 5, per the "2 months free" yearly ladder). */
const SEAT_INTERVAL_FACTOR: Record<BillingInterval, number> = {
  month: 1,
  halfyear: 5,
  year: 10,
  once: 1,
};

/**
 * Estimate a seated plan's total (Agency's seat selector) before checkout
 * confirms the real number. `includedSeats` defaults to 1 — Agency's own base
 * price already covers its first seat (B01's documented assumption, since
 * `GET /billing/plans` does not expose `entitlements.seatsIncluded`); every
 * seat above that costs `seatPriceMinor`, charged for as many months as the
 * interval covers.
 */
export function estimateSeatedTotalMinor(
  basePriceMinor: number,
  seatPriceMinor: number,
  seats: number,
  interval: BillingInterval,
  includedSeats = 1,
): number {
  const extraSeats = Math.max(0, seats - includedSeats);
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  return basePriceMinor + extraSeats * seatPriceMinor * SEAT_INTERVAL_FACTOR[interval];
}

export const INTERVAL_LABEL: Record<BillingInterval, string> = {
  month: "Monthly",
  year: "Yearly",
  halfyear: "Half-yearly",
  once: "Pay once",
};
