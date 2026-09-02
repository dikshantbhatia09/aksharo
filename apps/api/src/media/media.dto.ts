import { z } from "zod";

import { SUBTITLE_KINDS } from "./import/subtitle-parsers.js";
import { zodDto } from "../common/index.js";
import { IMPORT_MAX_BYTES } from "../projects/projects.constants.js";
import { ulidSchema } from "../projects/projects.dto.js";

/** Request and response schemas for the media ingest path. */

export const MEDIA_ROLES = ["primary", "broll", "audio"] as const;
export const MEDIA_STATUSES = [
  "pending",
  "uploading",
  "uploaded",
  "probing",
  "ready",
  "failed",
  "purged",
] as const;

/**
 * `POST /projects/{id}/media/init`.
 *
 * `size` is the client's declared byte count. It decides how many parts are
 * signed and it is checked against the plan cap *before* anything is signed —
 * but it is never trusted as fact: `complete` HEADs the finished object and
 * writes the store's own number.
 */
export const initUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z
    .number()
    .int()
    .min(1)
    // A ceiling well above any plan, so an absurd number is a validation error
    // rather than an entitlement lookup: 1 TiB.
    .max(1024 * 1024 * 1024 * 1024),
  mime: z.string().trim().min(3).max(255),
  /** Client-computed digest, used to recognise a re-upload of the same bytes. */
  contentHash: z.string().trim().min(8).max(128).optional(),
  role: z.enum(MEDIA_ROLES).optional(),
});

export class InitUploadDto extends zodDto(initUploadSchema) {}

/**
 * `POST /media/{mediaId}/complete`.
 *
 * `etags` are the `ETag` response headers of the part uploads, **in part order**:
 * the first entry is part 1. Quoting is not the caller's problem — S3 returns the
 * value quoted and the API accepts it either way.
 */
export const completeUploadSchema = z.object({
  etags: z.array(z.string().trim().min(1).max(256)).min(1).max(10_000),
});

export class CompleteUploadDto extends zodDto(completeUploadSchema) {}

/** `POST /projects/{id}/media/{mediaId}/replace` — a fresh upload onto one row. */
export const replaceMediaSchema = initUploadSchema;

export class ReplaceMediaDto extends zodDto(replaceMediaSchema) {}

export const importSubtitlesSchema = z.object({
  kind: z.enum(SUBTITLE_KINDS),
  content: z.string().min(1).max(IMPORT_MAX_BYTES),
  /** BCP-47 tag the cues are in, when the caller knows it. */
  language: z.string().trim().min(2).max(16).optional(),
  /** Attach to this media item rather than the project's primary one. */
  mediaId: ulidSchema.optional(),
});

export class ImportSubtitlesDto extends zodDto(importSubtitlesSchema) {}

export const importUrlSchema = z.object({
  url: z.string().trim().min(8).max(2_048),
  /** Omitted, the kind is taken from the URL's extension. */
  kind: z.enum(SUBTITLE_KINDS).optional(),
  language: z.string().trim().min(2).max(16).optional(),
  mediaId: ulidSchema.optional(),
});

export class ImportUrlDto extends zodDto(importUrlSchema) {}

// --- Response shapes (documentation only; the service builds the objects) ----

export const derivedKeysSchema = z.object({
  proxy: z.string().nullable(),
  audio16k: z.string().nullable(),
  audio48k: z.string().nullable(),
  waveform: z.string().nullable(),
  thumbs: z.array(z.string()),
});

export const mediaSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  role: z.string(),
  bucket: z.enum(["s3", "r2"]),
  storageKey: z.string(),
  filename: z.string().nullable(),
  mime: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  contentHash: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  fps: z.number().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  audioChannels: z.number().int().nullable(),
  status: z.enum(MEDIA_STATUSES),
  /** True when the bytes were replaced under a transcript that must be re-aligned. */
  needsRealign: z.boolean(),
  uploadedAt: z.string().nullable(),
  rawPurgeAt: z.string().nullable(),
  derivedPurgeAt: z.string().nullable(),
  derived: derivedKeysSchema,
  createdAt: z.string(),
});

export const uploadTicketSchema = z.object({
  mediaId: z.string(),
  /** Null when `duplicate` is true: the bytes are already in the bucket. */
  uploadId: z.string().nullable(),
  key: z.string(),
  bucket: z.enum(["s3", "r2"]),
  partSizeBytes: z.number().int(),
  parts: z.array(z.object({ partNumber: z.number().int(), url: z.string() })),
  /** ISO-8601; every part URL stops working then. */
  expiresAt: z.string().nullable(),
  /** True when an identical `contentHash` was already uploaded in this workspace. */
  duplicate: z.boolean(),
  media: mediaSchema,
});

export const completedUploadSchema = z.object({
  media: mediaSchema,
  /** The `media.probe` job the completion enqueued, and the `media.proxy` behind it. */
  probeJobId: z.string(),
  proxyJobId: z.string(),
});

export const mediaUrlsSchema = z.object({
  mediaId: z.string(),
  proxy: z.string().optional(),
  audio16k: z.string().optional(),
  audio48k: z.string().optional(),
  waveform: z.string().optional(),
  thumbs: z.array(z.string()),
  /** ISO-8601; every URL above stops working then (5 minutes). */
  expiresAt: z.string(),
});

export const importResultSchema = z.object({
  mediaId: z.string(),
  kind: z.enum(SUBTITLE_KINDS),
  key: z.string(),
  cueCount: z.number().int(),
  /** False for `txt`: there are no timings to trust, only text to align. */
  timed: z.boolean(),
  warnings: z.array(z.string()),
  /** The `ai.align` job the import enqueued. */
  jobId: z.string(),
});
