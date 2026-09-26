import { z } from "zod";

import { zodDto } from "../common/index.js";

import type { BucketSpec, RateLimitRule } from "../common/guards/index.js";

/**
 * Request shapes, codes and limits for a run's clips and manual moments
 * (`/repurpose/runs/{id}/clips`, `/repurpose/runs/{id}/candidates`), 2026-09-26.
 *
 * The bodies are deliberately loose about ranges: a moment that is too short,
 * too long or past the end of the video is answered with
 * `repurpose/clip_bounds_invalid`, a code the page has a sentence for, rather
 * than the generic validation failure a Zod range would produce.
 */

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

/**
 * `POST /repurpose/runs/{id}/clips`. Unknown keys are dropped rather than
 * refused, so the page's older `aspect` field (every clip is 9:16) is harmless.
 */
export const createClipSchema = z.object({ candidateId: ulid });
export class CreateClipDto extends zodDto(createClipSchema) {}
export type CreateClipInput = z.infer<typeof createClipSchema>;

/** `POST /repurpose/runs/{id}/candidates` — a moment the person chose by time. */
export const addCandidateSchema = z.object({
  startMs: z.number().finite(),
  endMs: z.number().finite(),
  title: z.string().trim().min(1).max(160).optional(),
});
export class AddCandidateDto extends zodDto(addCandidateSchema) {}
export type AddCandidateInput = z.infer<typeof addCandidateSchema>;

export const REPURPOSE_CLIP_ERRORS = {
  /** Cancelled, or no moments to cut yet (still analysing, or failed before any). */
  runNotReady: "repurpose/run_not_ready",
  /** Outside 3-180 s, or outside the video. */
  boundsInvalid: "repurpose/clip_bounds_invalid",
  /** Retry asked of a clip that is ready or already being cut. */
  clipNotRetryable: "repurpose/clip_not_retryable",
  /** The source's original file has been purged; nothing can be cut from it. */
  sourceExpired: "repurpose/source_expired",
  /** More clips or manual moments on one run than any person makes by hand. */
  limitReached: "repurpose/clip_limit",
  /**
   * A clip's state, never a refusal: its cut has been `running` far longer than
   * any cut takes, so its worker or its completion was lost (`clip-state.ts`).
   * Retrying cancels that job and cuts again.
   */
  cutStalled: "repurpose/clip_stalled",
} as const;

/** A moment's hard duration limits (§6.3), as `clip_candidates`' own CHECK has them. */
export const MIN_CLIP_MS = 3_000;
export const MAX_CLIP_MS = 180_000;

/** Kept either side of a cut so its boundary stays adjustable in the editor (§11.2). */
export const CLIP_HANDLE_MS = 500;

/**
 * The mezzanine's output height: a 1080 x 1920 picture, the 9:16 canvas the
 * clip project exports to. The worker never scales past the source's own crop.
 */
export const CLIP_MAX_HEIGHT = 1920;

/**
 * Sanity caps per run. Twenty AI moments plus twenty of the person's own is
 * more than anyone reviews; past that it is a script, not a person.
 */
export const MAX_CLIPS_PER_RUN = 40;
export const MAX_MANUAL_CANDIDATES_PER_RUN = 20;

/**
 * Cutting a clip decodes the source, so it is rate-limited per person on the
 * route and per run in the service: a stuck retry button or a runaway tab can
 * ask for a handful of cuts a minute, not hundreds.
 */
export const CLIP_RATE_LIMITS = {
  mutate: {
    name: "repurpose:clips:user",
    by: "user",
    capacity: 120,
    refillPerSec: 120 / 3600,
  },
} as const satisfies Record<string, RateLimitRule>;

export const CLIP_RUN_BUCKET: BucketSpec = {
  name: "repurpose:clips:run",
  capacity: 30,
  refillPerSec: 30 / 600,
};
