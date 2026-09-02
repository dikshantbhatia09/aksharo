import { z } from "zod";

import { UPI_AUTOPAY_CAP_MINOR } from "./billing.constants.js";

import type { $Enums } from "@prisma/client";

/**
 * Pure pricing and mandate-rule functions (B01 brief §2–3, D05, D40).
 *
 * Pure on purpose: the mandate cap rule and the ₹15,000 UPI ceiling are the
 * facts every checkout test asserts, and they have to be checkable without a
 * database, a workspace or a booted Nest application — exactly the reasoning
 * `workspaces/tax-profile.ts` gives for the same shape.
 */

// ---------------------------------------------------------------------------
// Plan prices (the `plans.prices` / `plans.seatPrice` JSONB columns)
// ---------------------------------------------------------------------------

const intervalPricesSchema = z.object({
  month: z.number().int().nonnegative(),
  year: z.number().int().nonnegative(),
  halfyear: z.number().int().nonnegative().optional(),
});

const planPricesSchema = z.object({ INR: intervalPricesSchema, USD: intervalPricesSchema });

export type PlanPrices = z.infer<typeof planPricesSchema>;

const seatPriceSchema = z.object({
  INR: z.number().int().nonnegative(),
  USD: z.number().int().nonnegative(),
});

export type SeatPrice = z.infer<typeof seatPriceSchema>;

/** Throws only on genuinely malformed seed data — never on a request the caller can fix. */
export function parsePlanPrices(raw: unknown): PlanPrices {
  return planPricesSchema.parse(raw);
}

export function parseSeatPrice(raw: unknown): SeatPrice | null {
  if (raw === null || raw === undefined) return null;
  return seatPriceSchema.parse(raw);
}

/** `entitlements.seatsIncluded`, defensively — 0 when the plan carries no seats. */
export function seatsIncluded(entitlements: unknown): number {
  if (entitlements === null || typeof entitlements !== "object") return 0;
  const value = (entitlements as Record<string, unknown>)["seatsIncluded"];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Price quote
// ---------------------------------------------------------------------------

/**
 * 30-day pay-once purchases are Starter and Creator only, at the monthly price
 * (04 §Offers: "Pay once: Starter and Creator as 30-day one-time purchases at
 * the monthly price for users who will not set up UPI Autopay"). Not in the
 * source doc for Studio/Agency/Free, so `once` is refused for them here.
 */
const ONCE_ELIGIBLE_PLANS: ReadonlySet<$Enums.PlanKey> = new Set(["starter", "creator"]);

/** How many billing periods a seat's monthly price is charged for, per interval. */
const SEAT_INTERVAL_FACTOR: Record<$Enums.BillingInterval, number> = {
  month: 1,
  halfyear: 5,
  year: 10,
  once: 1,
};

export interface PlanForPricing {
  readonly key: $Enums.PlanKey;
  readonly active: boolean;
  readonly prices: unknown;
  readonly seatPrice: unknown;
  readonly entitlements: unknown;
}

export interface PriceQuote {
  /** Undiscounted total, base plus extra seats — this IS the mandate cap (D40). */
  readonly listPriceMinor: number;
  readonly baseMinor: number;
  readonly seats: number;
  readonly seatsIncluded: number;
  readonly extraSeats: number;
  readonly extraSeatMinor: number;
}

export type PriceQuoteResult =
  | { readonly ok: true; readonly quote: PriceQuote }
  | { readonly ok: false; readonly reason: "plan_inactive" | "interval_unavailable" };

/**
 * List price for one plan/currency/interval/seat count — always the *full*
 * price. Coupons and streak discounts (B06, out of scope) apply only to what is
 * actually charged; the mandate cap this quote feeds is the undiscounted number
 * regardless (B01 brief §3: "streak discounts never exceed it").
 *
 * Seat pricing is not spelled out per-interval in `04-pricing-and-monetization
 * .md` (only a flat monthly `seatPrice` is seeded) — the year/halfyear seat cost
 * is derived here with the same "pay N months" ladder the base price uses
 * (×10 for yearly, ×5 for half-yearly), documented as an explicit assumption
 * in the B01 report.
 */
export function quotePrice(input: {
  readonly plan: PlanForPricing;
  readonly currency: $Enums.Currency;
  readonly interval: $Enums.BillingInterval;
  readonly seats?: number;
}): PriceQuoteResult {
  if (!input.plan.active) return { ok: false, reason: "plan_inactive" };
  if (input.interval === "once" && !ONCE_ELIGIBLE_PLANS.has(input.plan.key)) {
    return { ok: false, reason: "interval_unavailable" };
  }

  const prices = parsePlanPrices(input.plan.prices);
  const currencyPrices = prices[input.currency];
  const baseMinor =
    input.interval === "once"
      ? currencyPrices.month
      : input.interval === "halfyear"
        ? currencyPrices.halfyear
        : currencyPrices[input.interval];
  if (baseMinor === undefined) return { ok: false, reason: "interval_unavailable" };

  const included = seatsIncluded(input.plan.entitlements);
  const seatPrice = parseSeatPrice(input.plan.seatPrice);
  // A plan without a `seatPrice` (Free/Starter/Creator) is not sold per seat at
  // all — the base price already covers "the workspace", so a caller passing
  // `seats` for one of those is clamped to 1 rather than priced. Only Studio
  // and Agency (which both carry a `seatPrice`) charge for extra seats, and
  // even then the base subscription always covers at least its first seat
  // regardless of what `entitlements.seatsIncluded` says (Agency's own seed
  // sets it to 1 for exactly this reason).
  const effectiveIncluded = Math.max(included, 1);
  const requestedSeats = seatPrice === null ? 1 : Math.max(1, input.seats ?? effectiveIncluded);
  const extraSeats = seatPrice === null ? 0 : Math.max(0, requestedSeats - effectiveIncluded);
  const extraSeatMinor =
    seatPrice === null || extraSeats === 0
      ? 0
      : extraSeats * seatPrice[input.currency] * SEAT_INTERVAL_FACTOR[input.interval];

  return {
    ok: true,
    quote: {
      listPriceMinor: baseMinor + extraSeatMinor,
      baseMinor,
      seats: requestedSeats,
      seatsIncluded: included,
      extraSeats,
      extraSeatMinor,
    },
  };
}

/**
 * Apply a streak renewal discount (B06, D52: L2 5% / L3 10% off) to a list
 * price, never exceeding the mandate cap. `listPriceMinor` already IS the cap
 * (this file's own doc comment on {@link PriceQuote.listPriceMinor}), so this
 * is really "never below zero, never above the undiscounted price" — the
 * clamp exists for a caller passing a percent outside 0-100 by mistake, not
 * because the arithmetic could otherwise exceed the cap.
 */
export function applyDiscountWithinCap(listPriceMinor: number, percentOff: number): number {
  const clampedPercent = Math.min(100, Math.max(0, percentOff));
  const discounted = Math.round(listPriceMinor * (1 - clampedPercent / 100));
  return Math.min(listPriceMinor, Math.max(0, discounted));
}

/** Does this plan/currency have a `halfyear` price at all (Studio/INR today)? */
export function hasHalfyearPrice(plan: PlanForPricing, currency: $Enums.Currency): boolean {
  const prices = parsePlanPrices(plan.prices);
  return prices[currency].halfyear !== undefined;
}

// ---------------------------------------------------------------------------
// Mandate rule (D05, D40, THREAT-MODEL T9/T16, invariant 6)
// ---------------------------------------------------------------------------

export interface MandateChoice {
  readonly method: $Enums.MandateMethod;
  /** `true` when the RBI AFA-free ceiling is exceeded: AFA is required every debit. */
  readonly afaRequiredPerDebit: boolean;
}

export type MandateDecision =
  | { readonly ok: true; readonly kind: "recurring"; readonly mandate: MandateChoice }
  /**
   * A single non-recurring charge for the full amount, no mandate at all — the
   * "one card ... charge" reading of 04 §Offers ("Studio yearly ... is sold as
   * two half-yearly UPI debits of ₹9,996, or one card/eNACH charge, or pay-once
   * with a reminder"). Reached only via an explicit `method: "card"` above the
   * UPI cap: a caller who asked for card and got a one-time charge instead of a
   * silent recurring mandate is the safer failure mode.
   */
  | { readonly ok: true; readonly kind: "one_time"; readonly method: "card" }
  | { readonly ok: false; readonly reason: "cap_exceeded" };

/**
 * The ₹15,000 rule, exactly as `prisma/sql/0003-checks.sql`'s
 * `mandates_upi_cap_check` enforces it in the database: **no UPI Autopay
 * mandate may register above ₹15,000** — not "AFA required above it", a hard
 * block, because UPI Autopay does not support recurring debits above the cap at
 * all (RR-05 C4). eNACH has no such ceiling; above ₹15,000 it needs fresh
 * authentication (AFA) on every debit instead of a one-time authentication
 * (RR-05 B1), which is what `afaRequiredPerDebit` records. A `card` request
 * above the cap becomes a one-time charge rather than a recurring mandate —
 * see {@link MandateDecision}'s `"one_time"` branch.
 *
 * International (USD) checkout has no UPI concept — Razorpay's international
 * rail is cards only (D39) — so the ₹15,000 rule, an RBI rule for Indian
 * recurring payments, does not apply; `currency: "USD"` always resolves to a
 * recurring `method: "card"` regardless of what was requested.
 */
export function decideMandate(input: {
  readonly currency: $Enums.Currency;
  readonly capMinor: number;
  readonly requestedMethod?: $Enums.MandateMethod;
}): MandateDecision {
  if (input.currency === "USD") {
    return { ok: true, kind: "recurring", mandate: { method: "card", afaRequiredPerDebit: false } };
  }

  const method = input.requestedMethod ?? "upi_autopay";
  const overCap = input.capMinor > UPI_AUTOPAY_CAP_MINOR;

  if (method === "upi_autopay") {
    if (overCap) return { ok: false, reason: "cap_exceeded" };
    return {
      ok: true,
      kind: "recurring",
      mandate: { method: "upi_autopay", afaRequiredPerDebit: false },
    };
  }

  if (method === "card" && overCap) {
    return { ok: true, kind: "one_time", method: "card" };
  }

  return {
    ok: true,
    kind: "recurring",
    mandate: { method, afaRequiredPerDebit: overCap },
  };
}
