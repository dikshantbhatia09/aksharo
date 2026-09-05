import { z } from "zod";

import { PROJECT_BATCH_MAX, PROJECTS_MAX_PAGE_SIZE } from "./projects.constants.js";
import { zodDto } from "../common/index.js";

/**
 * Request and response schemas for `/projects` and `/folders`.
 *
 * As everywhere else in this app the Zod schema is the single source of truth: it
 * validates the request AND generates the OpenAPI shape `@montaj/api-client` is
 * built from, so there is no second description that can drift.
 */

export const PROJECT_STATUSES = ["draft", "active", "archived"] as const;
export const PROJECT_ASPECTS = ["9:16", "16:9", "1:1", "4:5"] as const;

/** A ULID, as it arrives from a client. */
export const ulidSchema = z
  .string()
  .trim()
  .length(26)
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a ULID");

export const projectTitleSchema = z.string().trim().min(1).max(200);

/** An agency's client label; free text, but bounded and trimmed. */
export const clientTagSchema = z.string().trim().min(1).max(64);

export const createProjectSchema = z.object({
  title: projectTitleSchema,
  folderId: ulidSchema.optional(),
  clientTag: clientTagSchema.optional(),
  aspect: z.enum(PROJECT_ASPECTS).optional(),
  sourceLanguage: z.string().trim().min(2).max(16).optional(),
});

export class CreateProjectDto extends zodDto(createProjectSchema) {}

export const updateProjectSchema = z
  .object({
    title: projectTitleSchema,
    /** `null` moves the project back to the root of the workspace. */
    folderId: ulidSchema.nullable(),
    clientTag: clientTagSchema.nullable(),
    aspect: z.enum(PROJECT_ASPECTS),
    sourceLanguage: z.string().trim().min(2).max(16).nullable(),
    /** Archiving is a status change, which is why there is no `/archive` route. */
    status: z.enum(PROJECT_STATUSES),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "supply at least one field");

export class UpdateProjectDto extends zodDto(updateProjectSchema) {}

/**
 * `POST /projects/batch` — create several projects in one call.
 *
 * A stub in the sense the brief means: it creates the rows and nothing else. The
 * batch *orchestration* (upload a folder of files, transcribe each, report
 * progress as one unit) is B15, and it will build on these rows.
 */
export const batchCreateProjectsSchema = z.object({
  projects: z.array(createProjectSchema).min(1).max(PROJECT_BATCH_MAX),
  /** Applied to every project in the batch that does not name its own. */
  folderId: ulidSchema.optional(),
  clientTag: clientTagSchema.optional(),
});

export class BatchCreateProjectsDto extends zodDto(batchCreateProjectsSchema) {}

export const listProjectsQuerySchema = z.object({
  /** Case-insensitive substring of the title. */
  q: z.string().trim().min(1).max(200).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  /** A folder id, or the literal `root` for projects in no folder. */
  folder: z.union([ulidSchema, z.literal("root")]).optional(),
  clientTag: clientTagSchema.optional(),
  /** Id of the last item on the previous page. */
  cursor: ulidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PROJECTS_MAX_PAGE_SIZE).optional(),
});

export class ListProjectsQueryDto extends zodDto(listProjectsQuerySchema) {}

export const createFolderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: ulidSchema.optional(),
  position: z.number().int().min(0).max(100_000).optional(),
});

export class CreateFolderDto extends zodDto(createFolderSchema) {}

export const updateFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** `null` moves the folder to the top level. */
    parentId: ulidSchema.nullable(),
    position: z.number().int().min(0).max(100_000),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "supply at least one field");

export class UpdateFolderDto extends zodDto(updateFolderSchema) {}

// --- Response shapes (documentation only; the services build the objects) ----

export const projectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  folderId: z.string().nullable(),
  clientTag: z.string().nullable(),
  sourceLanguage: z.string().nullable(),
  scripts: z.array(z.string()),
  aspect: z.enum(PROJECT_ASPECTS),
  status: z.enum(PROJECT_STATUSES),
  thumbnailKey: z.string().nullable(),
  /** FIX-05: a short-lived presigned GET for `thumbnailKey`; absent when there is none. */
  thumbnailUrl: z.string().optional(),
  durationMs: z.number().int().nullable(),
  mediaCount: z.number().int(),
  lastActivityAt: z.string(),
  /** When the plan's retention window closes on this project (D47). */
  retentionUntil: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});

export const projectPageSchema = z.object({
  items: z.array(projectSchema),
  nextCursor: z.string().nullable(),
});

export const folderSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  position: z.number().int(),
  projectCount: z.number().int(),
  createdAt: z.string(),
});

export const batchCreateResultSchema = z.object({
  created: z.array(projectSchema),
});
