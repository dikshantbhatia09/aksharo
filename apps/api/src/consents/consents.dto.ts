import { z } from "zod";

import { zodDto } from "../common/index.js";

/**
 * `consent_records.purpose` in schema order (06). Every purpose the notice asks
 * about is answerable here, including the two the product only uses later
 * (`share_upload`, `affiliate`) — a purpose that cannot be refused in advance is
 * not really granular.
 */
export const CONSENT_PURPOSES = [
  "analytics",
  "memory",
  "marketing",
  "share_upload",
  "affiliate",
] as const;

export const consentPurposeSchema = z.enum(CONSENT_PURPOSES);

export const setConsentSchema = z.object({
  purpose: consentPurposeSchema,
  granted: z.boolean(),
});

export class SetConsentDto extends zodDto(setConsentSchema) {}

// --- Response shapes (documentation only) -----------------------------------

export const consentStateSchema = z.object({
  purpose: consentPurposeSchema,
  granted: z.boolean(),
  /** The notice version the current answer was given against. */
  version: z.string().nullable(),
  decidedAt: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  /** `false` until the person has answered this purpose at least once. */
  recorded: z.boolean(),
});

export const consentsResponseSchema = z.object({
  noticeVersion: z.string(),
  /** `true` when a purpose was last answered against an older notice. */
  reconsentRequired: z.boolean(),
  purposes: z.array(consentStateSchema),
});
