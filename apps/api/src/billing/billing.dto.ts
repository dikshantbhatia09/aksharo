import { z } from "zod";

import { zodDto } from "../common/index.js";

import type { $Enums } from "@prisma/client";

/**
 * Request and response schemas for `/billing/*` (B01 brief §3–6).
 *
 * As in `workspaces/workspaces.dto.ts`, the Zod schema validates the request
 * and generates the OpenAPI shape `@montaj/api-client` is built from.
 */

const planKeySchema = z.enum(["free", "starter", "creator", "studio", "agency"]);
const intervalSchema = z.enum(["month", "year", "halfyear", "once"]);
const mandateMethodSchema = z.enum(["upi_autopay", "card", "enach"]);

/**
 * `{planKey, interval, coupon?}` per the brief. `seats` (Agency, and Studio
 * beyond its included three) and an explicit `method` are extensions beyond the
 * brief's literal shape: `method` is what makes a `mandate_cap_exceeded`
 * alternative (`halfyear_upi` / `card_once` / `enach`) actionable by retrying
 * checkout, and `seats` is required for the Agency per-seat acceptance test.
 * Both are optional so the brief's exact shape still works unchanged.
 */
export const checkoutSchema = z.object({
  planKey: planKeySchema,
  interval: intervalSchema,
  coupon: z.string().trim().min(1).max(64).optional(),
  seats: z.number().int().positive().max(500).optional(),
  method: mandateMethodSchema.optional(),
});

export class CheckoutDto extends zodDto(checkoutSchema) {}

export const changePreviewQuerySchema = z.object({
  planKey: planKeySchema,
  interval: intervalSchema,
  seats: z.coerce.number().int().positive().max(500).optional(),
});

export class ChangePreviewQueryDto extends zodDto(changePreviewQuerySchema) {}

export const changePlanSchema = z.object({
  planKey: planKeySchema,
  interval: intervalSchema,
  seats: z.number().int().positive().max(500).optional(),
  method: mandateMethodSchema.optional(),
});

export class ChangePlanDto extends zodDto(changePlanSchema) {}

const passKindSchema = z.enum(["first_export", "week_pass", "pay_once"]);

export const passCheckoutSchema = z.object({
  kind: passKindSchema,
  /** Required for `pay_once` (whose plan's credit allotment is being bought). */
  planKey: planKeySchema.optional(),
});

export class PassCheckoutDto extends zodDto(passCheckoutSchema) {}

export const topupCheckoutSchema = z.object({
  credits: z.number().int().positive(),
});

export class TopupCheckoutDto extends zodDto(topupCheckoutSchema) {}

// ---------------------------------------------------------------------------
// Response shapes (for the OpenAPI document; services return these directly)
// ---------------------------------------------------------------------------

export const planViewSchema = z.object({
  key: planKeySchema,
  name: z.string(),
  prices: z.record(z.string(), z.record(z.string(), z.number())),
  creditsPerMonthTenths: z.number(),
  seatPrice: z.record(z.string(), z.number()).nullable(),
});

export const checkoutAlternativeSchema = z.object({
  kind: z.enum(["halfyear_upi", "card_once", "enach"]),
  interval: intervalSchema,
  method: mandateMethodSchema,
  amountMinor: z.number(),
  currency: z.enum(["INR", "USD"]),
});

export const checkoutResponseSchema = z.object({
  subscriptionId: z.string(),
  status: z.string(),
  keyId: z.string(),
  amountMinor: z.number(),
  currency: z.enum(["INR", "USD"]),
  interval: intervalSchema,
  mandateCapMinor: z.number().nullable(),
  method: mandateMethodSchema.nullable(),
  providerSubscriptionId: z.string().optional(),
  providerOrderId: z.string().optional(),
  prefill: z.object({ email: z.string().optional(), contact: z.string().optional() }).optional(),
  notes: z.record(z.string(), z.string()).optional(),
});

export const subscriptionViewSchema = z.object({
  id: z.string(),
  planKey: planKeySchema,
  status: z.string(),
  interval: intervalSchema,
  currency: z.enum(["INR", "USD"]),
  listPriceMinor: z.number(),
  currentPeriodStart: z.string(),
  currentPeriodEnd: z.string(),
  renewalInitiateAt: z.string().nullable(),
  graceUntil: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  pausedUntil: z.string().nullable(),
  seats: z.number(),
  mandateId: z.string().nullable(),
});

export const mandateViewSchema = z.object({
  id: z.string(),
  method: mandateMethodSchema,
  maxAmountMinor: z.number(),
  currency: z.enum(["INR", "USD"]),
  status: z.string(),
  afaRequiredPerDebit: z.boolean(),
  validFrom: z.string(),
  validUntil: z.string().nullable(),
});

export const changePreviewSchema = z.object({
  currentListPriceMinor: z.number(),
  newListPriceMinor: z.number(),
  prorationCreditMinor: z.number(),
  amountDueNowMinor: z.number(),
  mandateReRegistrationRequired: z.boolean(),
  currency: z.enum(["INR", "USD"]),
});

// ---------------------------------------------------------------------------
// Response TS shapes returned directly by services (mirror the schemas above;
// kept beside them rather than in a separate types-only file so every export
// here compiles to something with real coverable statements — CONTRACTS §9's
// `**/index.ts` exclusion is for pure re-exports, and a file of nothing but
// `export interface` is the same shape of dead weight for the coverage gate).
// ---------------------------------------------------------------------------

export interface CheckoutAlternative {
  readonly kind: "halfyear_upi" | "card_once" | "enach";
  readonly interval: $Enums.BillingInterval;
  readonly method: $Enums.MandateMethod;
  readonly amountMinor: number;
  readonly currency: $Enums.Currency;
}

export interface CheckoutResponse {
  readonly subscriptionId: string;
  readonly status: string;
  readonly keyId: string;
  readonly amountMinor: number;
  readonly currency: $Enums.Currency;
  readonly interval: $Enums.BillingInterval;
  /** `null` for a one-time order — nothing is mandated. */
  readonly mandateCapMinor: number | null;
  readonly method: $Enums.MandateMethod | null;
  readonly providerSubscriptionId?: string;
  readonly providerOrderId?: string;
  readonly prefill?: { readonly email?: string; readonly contact?: string };
  readonly notes?: Record<string, string>;
}

export interface SubscriptionView {
  readonly id: string;
  readonly planKey: $Enums.PlanKey;
  readonly status: $Enums.SubscriptionStatus;
  readonly interval: $Enums.BillingInterval;
  readonly currency: $Enums.Currency;
  readonly listPriceMinor: number;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly renewalInitiateAt: string | null;
  readonly graceUntil: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly pausedUntil: string | null;
  readonly seats: number;
  readonly mandateId: string | null;
}

export interface MandateView {
  readonly id: string;
  readonly method: $Enums.MandateMethod;
  readonly maxAmountMinor: number;
  readonly currency: $Enums.Currency;
  readonly status: $Enums.MandateStatus;
  readonly afaRequiredPerDebit: boolean;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface ChangePreview {
  readonly currentListPriceMinor: number;
  readonly newListPriceMinor: number;
  /** Unused days on the current plan, credited toward the new one. */
  readonly prorationCreditMinor: number;
  readonly amountDueNowMinor: number;
  readonly mandateReRegistrationRequired: boolean;
  readonly currency: $Enums.Currency;
}

export interface PassCheckoutResponse {
  readonly passPurchaseId: string;
  readonly keyId: string;
  readonly providerOrderId: string;
  readonly amountMinor: number;
  readonly currency: $Enums.Currency;
  readonly creditsGrantedTenths: number;
}
