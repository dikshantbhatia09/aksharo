import { z } from "zod";

import { zodDto } from "../common/index.js";

import type { $Enums } from "@prisma/client";

/**
 * Request and response shapes for `/offers/*` and `/admin/metrics/offers`.
 * As in `billing/billing.dto.ts`, the Zod schema both validates the request
 * and generates the OpenAPI shape `@montaj/api-client` is built from.
 */

const currencySchema = z.enum(["INR", "USD"]);

export const ninePassEligibilityViewSchema = z.object({
  /** An unconsumed, paid pass exists right now — the export dialog can clear a watermark. */
  available: z.boolean(),
  /** May the workspace start a *new* checkout for one? (independent of `available`.) */
  eligibleToBuy: z.boolean(),
  reason: z.enum(["currency_not_inr", "on_paid_plan", "purchased_within_30_days"]).nullable(),
  nextEligibleAt: z.string().nullable(),
  priceMinor: z.number(),
  currency: currencySchema,
});

export const weekPassEligibilityViewSchema = z.object({
  active: z.boolean(),
  endsAt: z.string().nullable(),
  priceMinor: z.number(),
  currency: currencySchema,
  creditsGrantedTenths: z.number(),
  days: z.number(),
});

export const topupEligibilityViewSchema = z.object({
  /** The ₹149/100-credit tier is allowed on Free (D55 closes the ladder gap). */
  available: z.boolean(),
  priceMinor: z.number(),
  currency: currencySchema,
  credits: z.number(),
});

export const offersEligibilityViewSchema = z.object({
  signupGift: z.object({ available: z.boolean() }),
  ninePass: ninePassEligibilityViewSchema,
  weekPass: weekPassEligibilityViewSchema,
  topupFree149: topupEligibilityViewSchema,
});

export const passStatusSchema = z.enum([
  "pending_payment",
  "available",
  "active",
  "redeemed",
  "expired",
]);

export const passViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["first_export", "week_pass", "pay_once", "topup"]),
  status: passStatusSchema,
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  creditsGrantedTenths: z.number(),
  redeemedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const simulateNinePassPaymentSchema = z.object({ passPurchaseId: z.string() });
export class SimulateNinePassPaymentDto extends zodDto(simulateNinePassPaymentSchema) {}

export const consumeSignupGiftDevSchema = z.object({ workspaceId: z.string() });
export class ConsumeSignupGiftDevDto extends zodDto(consumeSignupGiftDevSchema) {}

// ---------------------------------------------------------------------------
// Response TS shapes (mirror the schemas; see billing.dto.ts's own note on
// why these are plain interfaces beside the schema rather than inferred —
// CONTRACTS §9 coverage).
// ---------------------------------------------------------------------------

export interface NinePassEligibilityView {
  readonly available: boolean;
  readonly eligibleToBuy: boolean;
  readonly reason: "currency_not_inr" | "on_paid_plan" | "purchased_within_30_days" | null;
  readonly nextEligibleAt: string | null;
  readonly priceMinor: number;
  readonly currency: $Enums.Currency;
}

export interface WeekPassEligibilityView {
  readonly active: boolean;
  readonly endsAt: string | null;
  readonly priceMinor: number;
  readonly currency: $Enums.Currency;
  readonly creditsGrantedTenths: number;
  readonly days: number;
}

export interface TopupEligibilityView {
  readonly available: boolean;
  readonly priceMinor: number;
  readonly currency: $Enums.Currency;
  readonly credits: number;
}

export interface OffersEligibilityView {
  readonly signupGift: { readonly available: boolean };
  readonly ninePass: NinePassEligibilityView;
  readonly weekPass: WeekPassEligibilityView;
  readonly topupFree149: TopupEligibilityView;
}

export type PassStatus = "pending_payment" | "available" | "active" | "redeemed" | "expired";

export interface PassView {
  readonly id: string;
  readonly kind: $Enums.PassPurchaseKind;
  readonly status: PassStatus;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly creditsGrantedTenths: number;
  readonly redeemedAt: string | null;
  readonly createdAt: string;
}
