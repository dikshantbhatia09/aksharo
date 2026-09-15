import { z } from "zod";

import {
  DEFAULT_MAX_CANDIDATE_MS,
  DEFAULT_MIN_CANDIDATE_MS,
  DEFAULT_REQUESTED_CANDIDATES,
  RUN_PAGE_MAX,
  RUN_PAGE_SIZE,
} from "./repurpose.constants.js";
import { STAGES } from "./repurpose.projection.js";
import { zodDto } from "../common/index.js";

/**
 * Request and response shapes for `/repurpose/runs` (REP-006).
 *
 * These mirror `@montaj/repurpose-contracts` rather than importing it into the
 * Nest DTO layer, for the same reason every other module keeps its own DTOs: the
 * contract package is the cross-runtime shape, and the DTO is what this HTTP
 * surface accepts, including the Swagger metadata `zodDto` attaches.
 * `repurpose.dto.test.ts` asserts the two agree, so a drift is a test failure.
 */

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const language = z.string().trim().min(2).max(64);
const shortLabel = z.string().trim().min(1).max(160);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const captionSetupSchema = z.object({
  /** `"same"` keeps the spoken language; anything else is a target language. */
  outputLanguage: z.union([z.literal("same"), language]).default("same"),
  /** Roman Hindi is `roman` + `hi-Latn`, never flattened to English (§10.4). */
  scriptMode: z.enum(["auto", "roman", "native", "bilingual"]).default("auto"),
  styleId: shortLabel,
});

export const discoverySetupSchema = z
  .object({
    mode: z.enum(["ai", "manual", "mixed"]).default("ai"),
    requestedCandidates: z.number().int().min(0).max(20).default(DEFAULT_REQUESTED_CANDIDATES),
    minDurationMs: z.number().int().min(3_000).max(180_000).default(DEFAULT_MIN_CANDIDATE_MS),
    maxDurationMs: z.number().int().min(3_000).max(180_000).default(DEFAULT_MAX_CANDIDATE_MS),
    contentGoal: z.enum(["reach", "education", "authority", "engagement"]).default("reach"),
  })
  .superRefine((value, context) => {
    if (value.minDurationMs > value.maxDurationMs) {
      context.addIssue({
        code: "custom",
        path: ["maxDurationMs"],
        message: "The longest clip cannot be shorter than the shortest.",
      });
    }
    if (value.mode === "manual" && value.requestedCandidates !== 0) {
      context.addIssue({
        code: "custom",
        path: ["requestedCandidates"],
        message: "Manual mode does not ask for AI suggestions.",
      });
    }
  });

/**
 * The source, as a discriminated union.
 *
 * `rightsAttested` is `true` and nothing else for an external link: a checkbox
 * the user must actively tick, recorded with a timestamp (§9.3). It is an
 * attestation, not proof — it makes the claim auditable, it does not verify it.
 */
export const createRunSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("url"),
    url: z.string().trim().min(1).max(2_048),
    rightsAttested: z.literal(true),
  }),
  z.object({
    kind: z.literal("upload"),
    filename: shortLabel,
    mime: z.string().trim().min(3).max(100),
    sizeBytes: z.number().int().positive().max(10_000_000_000),
    /** Client-computed hash, so a re-upload of the same file is deduplicated. */
    contentHash: sha256.optional(),
  }),
]);

export const createRunSchema = z.object({
  source: createRunSourceSchema,
  setup: z.object({
    sourceLanguage: language,
    caption: captionSetupSchema,
    discovery: discoverySetupSchema,
  }),
  /** Optional title; defaults to the source's safe display form. */
  title: shortLabel.optional(),
});
export class CreateRunDto extends zodDto(createRunSchema) {}

export const listRunsSchema = z.object({
  cursor: ulid.optional(),
  limit: z.coerce.number().int().min(1).max(RUN_PAGE_MAX).default(RUN_PAGE_SIZE),
  status: z
    .enum([
      "draft",
      "acquiring",
      "preparing_media",
      "transcribing",
      "analyzing",
      "candidates_ready",
      "materializing",
      "rendering",
      "review_ready",
      "changes_requested",
      "approved",
      "publishing",
      "partially_published",
      "published",
      "failed",
      "cancelled",
    ])
    .optional(),
});
export class ListRunsDto extends zodDto(listRunsSchema) {}

const stageViewSchema = z.object({
  stage: z.enum(STAGES),
  state: z.enum(["waiting", "running", "complete", "failed"]),
  label: z.string(),
});

/** What every run-shaped response returns. No job id, no queue name (§13.4). */
export const runViewSchema = z.object({
  id: ulid,
  workspaceId: ulid,
  sourceProjectId: ulid,
  sourceKind: z.enum(["upload", "youtube_url", "direct_media_url"]),
  sourceDisplay: z.string().nullable(),
  mode: z.enum(["ai", "manual", "mixed"]),
  status: z.string(),
  currentStage: z.enum(STAGES),
  progress: z.number().int().min(0).max(100),
  stages: z.array(stageViewSchema),
  message: z.string(),
  failureCode: z.string().nullable(),
  canCancel: z.boolean(),
  canRetry: z.boolean(),
  candidateCount: z.number().int().min(0),
  clipCount: z.number().int().min(0),
  variantCount: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const runPageSchema = z.object({
  items: z.array(runViewSchema),
  nextCursor: z.string().nullable(),
});

/** The upload ticket, re-exported unchanged from the existing media contract. */
const uploadTicketSchema = z.object({
  mediaId: ulid,
  uploadId: z.string().nullable(),
  key: z.string(),
  bucket: z.enum(["s3", "r2"]),
  partSizeBytes: z.number().int(),
  parts: z.array(z.object({ partNumber: z.number().int(), url: z.string() })),
  expiresAt: z.string().nullable(),
  duplicate: z.boolean(),
});

export const createRunResponseSchema = z.object({
  run: runViewSchema,
  projectId: ulid,
  /** Present only for an upload; a link run has nothing for the browser to PUT. */
  upload: uploadTicketSchema.nullable(),
  next: z.object({ rel: z.literal("run"), href: z.string() }),
});

export type CreateRunInput = z.infer<typeof createRunSchema>;
export type ListRunsInput = z.infer<typeof listRunsSchema>;
export type RunView = z.infer<typeof runViewSchema>;
export type RunPage = z.infer<typeof runPageSchema>;
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;
