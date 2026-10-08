import { z } from "zod";
import { zodDto } from "../common/index.js";
import { MEDIA_ROLES } from "./media.dto.js";

export const MAX_RESUMABLE_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
export const RESUMABLE_CHUNK_SIZE_BYTES = 16 * 1024 * 1024; // 16 MB

export const initiateMultipartUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileSizeBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_RESUMABLE_UPLOAD_BYTES),
  mimeType: z.string().trim().min(3).max(255),
  contentHash: z.string().trim().min(8).max(128).optional(),
  projectId: z.string().trim().optional(),
  role: z.enum(MEDIA_ROLES).optional().default("primary"),
});

export class InitiateMultipartUploadDto extends zodDto(initiateMultipartUploadSchema) {}

export const signPartUrlSchema = z.object({
  uploadId: z.string().trim().min(1),
  s3Key: z.string().trim().min(1),
  partNumber: z.number().int().min(1).max(10_000),
});

export class SignPartUrlDto extends zodDto(signPartUrlSchema) {}

export const completedPartSchema = z.object({
  PartNumber: z.number().int().min(1).max(10_000),
  ETag: z.string().trim().min(1),
});

export const completeMultipartUploadSchema = z.object({
  uploadId: z.string().trim().min(1),
  s3Key: z.string().trim().min(1),
  parts: z.array(completedPartSchema).min(1).max(10_000),
  projectId: z.string().trim().optional(),
});

export class CompleteMultipartUploadDto extends zodDto(completeMultipartUploadSchema) {}

export const abortMultipartUploadSchema = z.object({
  uploadId: z.string().trim().min(1),
  s3Key: z.string().trim().min(1),
});

export class AbortMultipartUploadDto extends zodDto(abortMultipartUploadSchema) {}

export const initiateUploadResponseSchema = z.object({
  sessionId: z.string(),
  uploadId: z.string(),
  s3Key: z.string(),
  chunkSize: z.number().int(),
  totalParts: z.number().int(),
  initialPartUrl: z.string().optional(),
});

export const signPartUrlResponseSchema = z.object({
  partNumber: z.number().int(),
  url: z.string(),
  expiresInSeconds: z.number().int(),
});

export const completeUploadResponseSchema = z.object({
  success: z.boolean(),
  mediaId: z.string(),
  status: z.string(),
  probeJobId: z.string(),
});

