import { z } from "zod";

import { zodDto } from "../common/index.js";

export const SUPPORT_CATEGORIES = ["bug", "billing", "export", "account", "other"] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/**
 * The consent-gated diagnostics bundle (brief §5): assembled client-side, so
 * this is validated, not trusted — a caller could send anything, and this
 * schema is what stops "anything" from including media or an unbounded
 * payload. `jobs` caps at 10 (the brief's "last 10 job ids and statuses"),
 * `consoleErrors` at 20 lines (a ring buffer, so the client already caps it —
 * this is a second, server-side ceiling).
 */
export const SupportDiagnosticsSchema = z.object({
  appVersion: z.string().max(32),
  browser: z.string().max(120),
  os: z.string().max(120),
  workspaceId: z.string().length(26),
  jobs: z.array(z.object({ jobId: z.string().max(26), status: z.string().max(32) })).max(10),
  consoleErrors: z.array(z.string().max(500)).max(20),
});
export type SupportDiagnostics = z.infer<typeof SupportDiagnosticsSchema>;

export const createSupportTicketSchema = z.object({
  subject: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(5_000),
  category: z.enum(SUPPORT_CATEGORIES),
  diagnostics: SupportDiagnosticsSchema.optional(),
});
export type CreateSupportTicketInput = z.infer<typeof createSupportTicketSchema>;
export class CreateSupportTicketDto extends zodDto(createSupportTicketSchema) {}

export const supportTicketViewSchema = z.object({
  id: z.string(),
  subject: z.string(),
  category: z.string(),
  status: z.string(),
  hasDiagnostics: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SupportTicketView = z.infer<typeof supportTicketViewSchema>;

export const listSupportTicketsResponseSchema = z.object({
  tickets: z.array(supportTicketViewSchema),
});
export type ListSupportTicketsResponse = z.infer<typeof listSupportTicketsResponseSchema>;
