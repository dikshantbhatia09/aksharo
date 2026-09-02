import { z } from "zod";

import { zodDto } from "../common/index.js";

/**
 * Request and response shapes for `/referrals/*` (B07b). As in
 * `offers/offers.dto.ts`, the Zod schema both validates the request and
 * generates the OpenAPI shape `@montaj/api-client` is built from.
 */

export const claimReferralSchema = z.object({
  code: z.string().trim().min(1).max(32),
});
export type ClaimReferralInput = z.infer<typeof claimReferralSchema>;
export class ClaimReferralDto extends zodDto(claimReferralSchema) {}

export const claimReferralResultSchema = z.object({
  /** `false` when the code was not a referral code (`AK-` prefix) — a no-op, not an error. */
  claimed: z.boolean(),
  status: z.enum(["pending", "granted", "rejected"]).nullable(),
  reason: z.string().nullable(),
});
export type ClaimReferralResult = z.infer<typeof claimReferralResultSchema>;

export const referralStatsSchema = z.object({
  /** This workspace's own personal code — created on first read if it did not exist. */
  code: z.string(),
  pending: z.number().int(),
  granted: z.number().int(),
  rejected: z.number().int(),
  bonusGrantedAt: z.string().nullable(),
  /** Whether the give-get sheet has been shown once for this workspace already. */
  promptShownAt: z.string().nullable(),
  /**
   * `true` once this workspace has completed at least one export and the
   * sheet has not been shown yet — the exact condition the give-get sheet's
   * "after the first export, once per workspace" rule (brief §3) reduces to.
   * The mounting page only needs to read this one flag; it never re-derives
   * the export count itself.
   */
  promptEligible: z.boolean(),
});
export type ReferralStats = z.infer<typeof referralStatsSchema>;

export const dismissPromptResultSchema = z.object({ shownAt: z.string() });
export type DismissPromptResult = z.infer<typeof dismissPromptResultSchema>;
