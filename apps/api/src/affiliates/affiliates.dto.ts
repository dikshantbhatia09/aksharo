import { z } from "zod";

import { zodDto } from "../common/index.js";

/**
 * Request/response schemas for `/affiliate/*` (brief §1, §5, §6). As in
 * `billing/billing.dto.ts`, the Zod schema validates the request and
 * generates the OpenAPI shape `@montaj/api-client` is built from.
 */

const payoutMethodSchema = z.object({
  rail: z.enum(["neft", "imps", "rtgs", "upi"]),
  vpaOrAccountNumber: z.string().trim().min(4).max(64),
  ifsc: z.string().trim().length(11).optional(),
  accountHolderName: z.string().trim().min(1).max(120),
});

export const applyAffiliateSchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN must match AAAAA9999A"),
  gstin: z.string().trim().toUpperCase().optional(),
  payoutMethod: payoutMethodSchema,
  /** Acceptance of the ASCI disclosure clause verbatim (brief §6). Required. */
  acceptedDisclosure: z.literal(true),
});
export class ApplyAffiliateDto extends zodDto(applyAffiliateSchema) {}

export const affiliateViewSchema = z.object({
  id: z.string(),
  code: z.string(),
  status: z.string(),
  tier: z.string(),
  legalName: z.string().nullable(),
  panLast4: z.string().nullable(),
  gstin: z.string().nullable(),
  balanceMinor: z.number().int(),
  currency: z.string(),
  approvedAt: z.string().nullable(),
  createdAt: z.string(),
  referralLink: z.string(),
});
export type AffiliateView = z.infer<typeof affiliateViewSchema>;

export const affiliateStatsSchema = z.object({
  clicks: z.number().int(),
  signups: z.number().int(),
  paidReferrals: z.number().int(),
  activeReferrals: z.number().int(),
  pendingCommissionMinor: z.number().int(),
  availableCommissionMinor: z.number().int(),
  paidOutMinor: z.number().int(),
  fyLabel: z.string(),
  fyGrossMinor: z.number().int(),
  fyTdsMinor: z.number().int(),
  fyNetMinor: z.number().int(),
  tier: z.string(),
  activeReferralsForTierUpgrade: z.number().int(),
});
export type AffiliateStats = z.infer<typeof affiliateStatsSchema>;

export const recordClickSchema = z.object({
  code: z.string().trim().min(1).max(16),
  ipHash: z.string().trim().max(128).optional(),
  deviceHash: z.string().trim().max(128).optional(),
});
export class RecordClickDto extends zodDto(recordClickSchema) {}

export const attachCodeSchema = z.object({
  referredWorkspaceId: z.string(),
  referredUserId: z.string(),
  code: z.string().trim().min(1).max(16).optional(),
  cookieCode: z.string().trim().min(1).max(16).optional(),
  cookieExpiresAt: z.string().datetime().optional(),
  ipHash: z.string().trim().max(128).optional(),
  deviceHash: z.string().trim().max(128).optional(),
  paymentFingerprint: z.string().trim().max(128).optional(),
});
export class AttachCodeDto extends zodDto(attachCodeSchema) {}

export const adminAffiliateActionSchema = z.object({
  affiliateId: z.string(),
  reason: z.string().trim().max(500).optional(),
});
export class AdminAffiliateActionDto extends zodDto(adminAffiliateActionSchema) {}
