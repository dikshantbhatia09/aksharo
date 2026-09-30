/**
 * What a dub costs (2026-10-04): the person in credits, the product in rupees.
 *
 * The vendor (Sarvam's Dubbing API, checked 2026-09-29) charges ₹40 per
 * minute of source per target language, ₹0.667 a second. A person is charged
 * 50 credits per minute per language, on the clip's length rounded up to the
 * second; the daily rupee budget counts the vendor's price the same way. Both
 * round UP, so a quote is never below what the vendor bills.
 *
 * 50, not the 25 it shipped with (2026-09-30): a credit is worth Rs 1.99 on
 * Starter, 1.40 on Creator, 1.33 on Agency and 1.11 on Studio, so at 25 every
 * plan but Starter paid less than the vendor's Rs 40. At 50 Studio's cheapest
 * credits pay about Rs 55 a minute, which also covers failed and retried work.
 *
 * A constant here rather than a `BURN_RATES` row in `@montaj/config`: a burn
 * rate becomes every plan's `operations` entitlement in the plans seed, and
 * dubbing is switched on per workspace by its flag, not by plan.
 */

/** 50 credits a minute a language, in tenths. */
export const DUB_TENTHS_PER_MINUTE = 500;

/** ₹40 a minute a language, in paise: the vendor's price. */
export const DUB_VENDOR_PAISE_PER_MINUTE = 4_000;

/** The clip's length as billed: whole seconds, rounded up, never below one. */
export function billedSeconds(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  return Math.max(1, Math.ceil(durationMs / 1000));
}

/** Credits (tenths) a dub of `languages` languages of a clip this long holds. */
export function dubCostTenths(durationMs: number, languages: number): number {
  const count = Math.max(0, Math.floor(languages));
  return Math.ceil((billedSeconds(durationMs) * count * DUB_TENTHS_PER_MINUTE) / 60);
}

/** What the vendor charges for it, in paise: what the daily budget counts. */
export function dubVendorPaise(durationMs: number, languages: number): number {
  const count = Math.max(0, Math.floor(languages));
  return Math.ceil((billedSeconds(durationMs) * count * DUB_VENDOR_PAISE_PER_MINUTE) / 60);
}
