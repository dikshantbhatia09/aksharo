import { z } from "zod";

import { zodDto } from "../common/index.js";

/**
 * Request and response schemas for `/workspaces` and `/invitations`.
 *
 * As in `auth/dto`, the Zod schema is the single source of truth: it validates
 * the request and it generates the OpenAPI shape `@montaj/api-client` is built
 * from, so there is no second description that can drift.
 */

/** Lowercase, hyphen-separated, no leading or trailing hyphen. */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(48)
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded or disjoint-alternation pattern, reviewed and timed against adversarial input -- not exponential; see the WP report
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "letters, digits and single hyphens only");

export const workspaceNameSchema = z.string().trim().min(1).max(120);

/**
 * `workspaces.settings` — the `WorkspaceSettingsSchema` the schema comment names.
 *
 * Kept small on purpose: a setting belongs here once a feature reads it, and
 * every key added now is a key a later work package has to keep answering for.
 */
export const workspaceSettingsSchema = z.object({
  /** Default canvas for a new project (CONTRACTS §2 `canvas.aspect`). */
  defaultAspect: z.enum(["9:16", "16:9", "1:1", "4:5"]).optional(),
  /** BCP-47 tag a new transcript is assumed to be in. */
  defaultLanguage: z.string().trim().max(16).optional(),
  /** IANA zone for dates shown to the whole team. */
  timezone: z.string().trim().max(64).optional(),
  /** Send the workspace's members an email when a long job finishes. */
  notifyOnJobComplete: z.boolean().optional(),
  /** Members below `admin` may not invite (team scaffolding for B08). */
  membersCanInvite: z.boolean().optional(),
});

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const createWorkspaceSchema = z.object({
  name: workspaceNameSchema,
  slug: slugSchema.optional(),
  /** A person gets exactly one personal workspace, at sign-up; this makes teams. */
  type: z.enum(["team", "agency"]).optional(),
});

export class CreateWorkspaceDto extends zodDto(createWorkspaceSchema) {}

export const updateWorkspaceSchema = z
  .object({
    name: workspaceNameSchema,
    slug: slugSchema,
    settings: workspaceSettingsSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "supply at least one field");

export class UpdateWorkspaceDto extends zodDto(updateWorkspaceSchema) {}

/**
 * The tax profile (D41).
 *
 * `billingStateCode` is two digits — a GST State code, not a name and not an
 * ISO-3166-2 subdivision. `gstin` is normalised to upper case before the check
 * digit is verified.
 */
export const taxProfileSchema = z.object({
  billingCountry: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "must be an ISO-3166-1 alpha-2 country code"),
  billingStateCode: z
    .string()
    .trim()
    .regex(/^[0-9]{2}$/, "must be a two-digit GST State code")
    .optional(),
  gstin: z.string().trim().toUpperCase().min(15).max(15).optional(),
  legalName: z.string().trim().min(1).max(200).optional(),
});

export class TaxProfileDto extends zodDto(taxProfileSchema) {}

export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(254).email(),
  /** `owner` is never invitable: a workspace has exactly one, and it has one. */
  role: z.enum(["admin", "editor", "viewer"]),
});

export class InviteMemberDto extends zodDto(inviteMemberSchema) {}

export const changeRoleSchema = z.object({ role: z.enum(["admin", "editor", "viewer"]) });

export class ChangeRoleDto extends zodDto(changeRoleSchema) {}

// --- Response shapes (documentation only; the services build the objects) ----

export const workspaceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  type: z.enum(["personal", "team", "agency"]),
  ownerId: z.string(),
  region: z.enum(["in", "eu", "us"]),
  currency: z.enum(["INR", "USD"]),
  billingCountry: z.string(),
  /** Null while the country is still the sign-up guess; B01 blocks checkout then. */
  billingCountryConfirmedAt: z.string().nullable(),
  billingStateCode: z.string().nullable(),
  gstin: z.string().nullable(),
  gstinVerifiedAt: z.string().nullable(),
  legalName: z.string().nullable(),
  settings: workspaceSettingsSchema,
  retentionDays: z.number().int(),
  createdAt: z.string(),
  /** The caller's role, so a client does not need a second request to render. */
  role: z.enum(["owner", "admin", "editor", "viewer"]),
  memberCount: z.number().int(),
  /** True once a subscription exists: the currency can no longer change (04 §Tax). */
  currencyLocked: z.boolean(),
});

export const memberSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: z.enum(["owner", "admin", "editor", "viewer"]),
  status: z.enum(["invited", "active", "suspended", "removed"]),
  seatBilled: z.boolean(),
  createdAt: z.string(),
});

export const invitationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  role: z.enum(["owner", "admin", "editor", "viewer"]),
  invitedEmail: z.string().nullable(),
  createdAt: z.string(),
});

export const entitlementSchema = z.object({
  workspaceId: z.string(),
  planKey: z.enum(["free", "starter", "creator", "studio", "agency"]),
  planName: z.string(),
  creditsPerMonthTenths: z.number().int(),
  seatsIncluded: z.number().int(),
  seatsUsed: z.number().int(),
  entitlements: z.record(z.string(), z.unknown()),
  /** When this snapshot was computed; it is cached for 60 seconds (07). */
  computedAt: z.string(),
});
