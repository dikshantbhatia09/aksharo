import { z } from "zod";

import { BATCH_MAX_PROJECTS } from "./batch.constants.js";
import { zodDto } from "../common/index.js";
import { clientTagSchema, createProjectSchema, ulidSchema } from "../projects/projects.dto.js";

/**
 * Request/response schemas for `/batch` — the orchestration layer over
 * `POST /projects/batch` (B15 brief §4): "Apply to all" settings, an up-front
 * credit quote/confirm, and the progress view.
 */

/** One file's known duration, quoted before any project row exists. */
export const batchQuoteItemSchema = z.object({
  durationMs: z.number().int().min(0),
});

export const batchQuoteSchema = z.object({
  items: z.array(batchQuoteItemSchema).min(1).max(BATCH_MAX_PROJECTS),
});
export class BatchQuoteDto extends zodDto(batchQuoteSchema) {}

export const batchSettingsSchema = z.object({
  languages: z.array(z.string().trim().min(2).max(16)).min(1).max(8).optional(),
  stylePresetId: ulidSchema.optional(),
  exportPresetId: ulidSchema.optional(),
  audioClean: z.boolean().optional(),
});
export type BatchSettings = z.infer<typeof batchSettingsSchema>;

export const createBatchSchema = z.object({
  projects: z.array(createProjectSchema).min(1).max(BATCH_MAX_PROJECTS),
  folderId: ulidSchema.optional(),
  clientTag: clientTagSchema.optional(),
  settings: batchSettingsSchema.optional(),
  /** Durations in the same order as `projects`, for the settled quote. */
  durationsMs: z.array(z.number().int().min(0)).optional(),
});
export class CreateBatchDto extends zodDto(createBatchSchema) {}

export const applyBatchSchema = z.object({
  /** Overrides the batch's stored settings for this apply call, if given. */
  settings: batchSettingsSchema.optional(),
});
export class ApplyBatchDto extends zodDto(applyBatchSchema) {}

export const batchProjectStatusSchema = z.object({
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  latestJobStatus: z.string().nullable(),
  latestJobType: z.string().nullable(),
  latestJobError: z.string().nullable(),
});

export const batchViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  settings: batchSettingsSchema,
  creditsQuoted: z.string(),
  createdAt: z.string(),
  projects: z.array(batchProjectStatusSchema),
});
