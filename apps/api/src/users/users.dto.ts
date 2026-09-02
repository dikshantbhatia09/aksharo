import { z } from "zod";

import { zodDto } from "../common/index.js";

/**
 * Request and response schemas for `/me`.
 *
 * The Zod schema is the single source of truth: `zodDto()` turns it into the
 * class the global validation pipe uses, and `zodBody`/`zodResponse` turn the
 * same one into the OpenAPI shape `@montaj/api-client` is generated from. There
 * is no second, hand-written description that can drift.
 */

/** BCP-47-ish. Deliberately permissive: the UI offers a fixed list anyway. */
const localeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "must be a BCP-47 language tag")
  .max(16);

/**
 * Avatars are `https` URLs to the derived bucket (A06 issues them). No `data:`
 * and no `http:`: the value is rendered in the product and in emails.
 */
const avatarUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => value.startsWith("https://"), "must be an https URL");

/** Free-form onboarding progress; bounded so the JSONB column cannot be abused. */
export const onboardingSchema = z
  .record(z.string().max(48), z.union([z.boolean(), z.number(), z.string().max(200)]))
  .refine((value) => Object.keys(value).length <= 32, "at most 32 keys");

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).nullable(),
    avatarUrl: avatarUrlSchema.nullable(),
    locale: localeSchema,
    /** Mirrors the `marketing` consent purpose; both write a `consent_records` row. */
    marketingOptIn: z.boolean(),
    onboarding: onboardingSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "supply at least one field");

export class UpdateProfileDto extends zodDto(updateProfileSchema) {}

// --- Response shapes (documentation only; the service builds the objects) ----

export const profileSchema = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  locale: z.string(),
  jurisdiction: z.enum(["IN", "EU", "OTHER"]),
  ageBracket: z.enum(["adult", "minor"]),
  marketingOptIn: z.boolean(),
  onboarding: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  /** Set once `DELETE /me` has been accepted; the account is then read-only. */
  deletedAt: z.string().nullable(),
  /** The workspace the calling token is scoped to, and the caller's role in it. */
  workspace: z.object({ id: z.string(), role: z.string() }),
});

export const dataExportSchema = z.object({
  requestId: z.string(),
  status: z.enum(["received", "verifying", "in_progress", "completed", "rejected"]),
  requestedAt: z.string(),
  dueAt: z.string(),
  /** Present once the bundle is built. Short-lived and single-purpose. */
  downloadUrl: z.string().optional(),
  expiresAt: z.string().optional(),
  sizeBytes: z.number().int().optional(),
});

export const erasureSchema = z.object({
  requestId: z.string(),
  status: z.enum(["received", "verifying", "in_progress", "completed", "rejected"]),
  requestedAt: z.string(),
  /** DPDP Rule 14: the cascade completes within 30 days (B16 runs it). */
  dueAt: z.string(),
  sessionsRevoked: z.number().int(),
});
