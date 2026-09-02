import { z } from "zod";

import { zodDto } from "../common/index.js";
import { ulidSchema } from "../projects/projects.dto.js";

/**
 * Request and response schemas for `/projects/:id/share-links` (owner side) and
 * the public `/s/:token` viewer (B15 brief §1, §3).
 */

export const SHARE_LINK_SCOPES = ["view", "comment", "approve"] as const;
export const SHARE_REPORT_CATEGORIES = ["ncii", "impersonation", "copyright", "other"] as const;

export const createShareLinkSchema = z.object({
  scope: z.enum(SHARE_LINK_SCOPES).default("view"),
  password: z.string().trim().min(6).max(200).optional(),
  expiresAt: z.iso.datetime().optional(),
  maxViews: z.number().int().min(1).max(1_000_000).optional(),
  clientTag: z.string().trim().min(1).max(64).optional(),
});
export class CreateShareLinkDto extends zodDto(createShareLinkSchema) {}

export const shareLinkSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  token: z.string(),
  scope: z.enum(SHARE_LINK_SCOPES),
  hasPassword: z.boolean(),
  expiresAt: z.string().nullable(),
  maxViews: z.number().int().nullable(),
  viewCount: z.number().int(),
  clientTag: z.string().nullable(),
  reportCount: z.number().int(),
  revokedAt: z.string().nullable(),
  autoDisabled: z.boolean(),
  createdAt: z.string(),
  /** `/s/<token>` — the full path the owner copies into a message. */
  url: z.string(),
});
export class ShareLinkView {}

export const unlockShareLinkSchema = z.object({
  password: z.string().min(1).max(200),
});
export class UnlockShareLinkDto extends zodDto(unlockShareLinkSchema) {}

export const reportAbuseSchema = z.object({
  category: z.enum(SHARE_REPORT_CATEGORIES).default("other"),
  reporterContact: z.string().trim().min(3).max(320).optional(),
  details: z.string().trim().max(2000).optional(),
});
export class ReportAbuseDto extends zodDto(reportAbuseSchema) {}

export const shareDecisionSchema = z.object({
  decision: z.enum(["approved", "changes_requested"]),
});
export class ShareDecisionDto extends zodDto(shareDecisionSchema) {}

/** What the public viewer sees before it has decided whether to unlock anything. */
export const shareResolveSchema = z.object({
  projectId: z.string(),
  title: z.string(),
  scope: z.enum(SHARE_LINK_SCOPES),
  requiresPassword: z.boolean(),
  unlocked: z.boolean(),
  expired: z.boolean(),
  revoked: z.boolean(),
  reviewStatus: z.string(),
  aspect: z.string(),
});

export const commentAuthorSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.email().optional(),
});

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  atMs: z.number().int().min(0).optional(),
  segmentId: ulidSchema.optional(),
  parentId: ulidSchema.optional(),
  /** Guest identity — required when the caller has no session (public link). */
  author: commentAuthorSchema.optional(),
});
export class CreateCommentDto extends zodDto(createCommentSchema) {}

export const commentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  shareLinkId: z.string().nullable(),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  atMs: z.number().int().nullable(),
  segmentId: z.string().nullable(),
  parentId: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const listCommentsQuerySchema = z.object({
  resolved: z.coerce.boolean().optional(),
  segmentId: ulidSchema.optional(),
});
export class ListCommentsQueryDto extends zodDto(listCommentsQuerySchema) {}

export const resolveCommentSchema = z.object({
  resolved: z.boolean(),
});
export class ResolveCommentDto extends zodDto(resolveCommentSchema) {}
