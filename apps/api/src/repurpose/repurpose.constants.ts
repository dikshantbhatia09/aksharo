import type { RateLimitRule } from "../common/guards/index.js";

/**
 * REP-006 constants.
 *
 * Nothing here is reachable while `repurpose_flow` is off, which is how it is
 * seeded (`prisma/seed-data.ts`) and how it stays until Wave 0's provider,
 * licence and baseline evidence exists (`WAVE-0-FOUNDATION.md`).
 */

/** The rollout flags this module reads. All seeded disabled. */
export const REPURPOSE_FLAGS = {
  /** The entire guided surface. Off means every route below answers 404. */
  flow: "repurpose_flow",
  /** External YouTube acquisition. Off means only uploads may start a run. */
  youtubeAcquire: "source_youtube_acquire",
  /** AI candidate discovery. Off means manual mode only. */
  highlightDiscovery: "highlight_discovery",
} as const;

/**
 * Safe error codes, from `SAFE_ERROR_CODES` in `@montaj/repurpose-contracts`
 * plus the run-lifecycle codes the CRUD surface needs.
 *
 * A code is a promise to the UI: it maps to one sentence of plain language and
 * one recommended action. A provider or worker message never reaches a user.
 */
export const REPURPOSE_ERRORS = {
  notFound: "repurpose/not_found",
  disabled: "repurpose/not_available",
  sourceInvalidUrl: "repurpose/source_invalid_url",
  sourceRightsRequired: "repurpose/source_rights_required",
  sourceUnsupported: "repurpose/source_unsupported",
  sourceDuplicate: "repurpose/source_already_running",
  notCancellable: "repurpose/not_cancellable",
  notRetryable: "repurpose/not_retryable",
  styleUnknown: "repurpose/style_unknown",
} as const;

/**
 * Rate limits. Creating a run starts a download and a transcription, so it is
 * closer to `batch:create` than to an ordinary write; cancel and retry are
 * cheap but must not become a way to hammer the job ledger.
 */
export const REPURPOSE_RATE_LIMITS = {
  create: {
    name: "repurpose:create:user",
    by: "user",
    capacity: 20,
    refillPerSec: 20 / 3600,
  },
  mutate: {
    name: "repurpose:mutate:user",
    by: "user",
    capacity: 60,
    refillPerSec: 60 / 3600,
  },
} as const satisfies Record<string, RateLimitRule>;

/** Default AI suggestions when the caller does not say (master plan §3.3). */
export const DEFAULT_REQUESTED_CANDIDATES = 5;

/** Default candidate duration window; the hard limits are 3-180 s (§6.3). */
export const DEFAULT_MIN_CANDIDATE_MS = 15_000;
export const DEFAULT_MAX_CANDIDATE_MS = 60_000;

/** List page size, and its ceiling. */
export const RUN_PAGE_SIZE = 20;
export const RUN_PAGE_MAX = 50;
