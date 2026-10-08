import { z } from "zod";
import { zodDto } from "../common/index.js";

export const CLOUD_PROVIDERS = [
  "GOOGLE_DRIVE",
  "DROPBOX",
  "ONEDRIVE",
  "BOX",
] as const;

export const importCloudSchema = z.object({
  provider: z.enum([
    "GOOGLE_DRIVE",
    "DROPBOX",
    "ONEDRIVE",
    "BOX",
    "google_drive",
    "dropbox",
    "onedrive",
    "box",
  ]),
  fileId: z.string().trim().min(1).max(512),
  fileName: z.string().trim().max(255).optional(),
  fileSizeBytes: z.number().int().nonnegative().optional(),
  mimeType: z.string().trim().max(255).optional(),
  token: z.string().trim().optional(),
  directLink: z.string().trim().optional(),
  projectId: z.string().trim().optional(),
});

export class ImportCloudDto extends zodDto(importCloudSchema) {}

export const saveCloudIntegrationSchema = z.object({
  provider: z.enum(CLOUD_PROVIDERS),
  accountEmail: z.string().trim().email(),
  accessToken: z.string().trim().min(1),
  refreshToken: z.string().trim().optional(),
  expiresAt: z.string().datetime().optional(),
});

export class SaveCloudIntegrationDto extends zodDto(saveCloudIntegrationSchema) {}

export const cloudImportJobResponseSchema = z.object({
  jobId: z.string(),
  workspaceId: z.string(),
  projectId: z.string().nullable().optional(),
  provider: z.string(),
  fileId: z.string(),
  fileName: z.string(),
  fileSizeBytes: z.string(),
  status: z.enum(["QUEUED", "STREAMING", "COMPLETED", "FAILED"]),
  progressPct: z.number(),
  errorMessage: z.string().nullable().optional(),
  s3Key: z.string().nullable().optional(),
  mediaId: z.string().nullable().optional(),
  createdAt: z.string(),
  completedAt: z.string().nullable().optional(),
});

export class CloudImportJobResponseDto extends zodDto(cloudImportJobResponseSchema) {}

export const cloudIntegrationViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  provider: z.string(),
  accountEmail: z.string(),
  hasRefreshToken: z.boolean(),
  expiresAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class CloudIntegrationViewDto extends zodDto(cloudIntegrationViewSchema) {}

