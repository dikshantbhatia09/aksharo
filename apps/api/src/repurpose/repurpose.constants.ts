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
  stageTimeout: "repurpose/stage_timeout",
} as const;

/** Per-stage timeout deadlines (CORE-023). Moving a run past its deadline to failed. */
export const DEFAULT_STAGE_DEADLINES_MS: Readonly<Record<string, number>> = Object.freeze({
  getting_video: 40 * 60 * 1000,
  finding_clips: 30 * 60 * 1000,
  styles_formats: 30 * 60 * 1000,
  review: 0,
  publish: 15 * 60 * 1000,
});

export const STAGE_TIMEOUT_CUSTOMER_MESSAGE =
  "This stage took longer than expected. Your work is safe.";

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

/**
 * How long `media.acquire` may spend on one source, end to end.
 *
 * Forty minutes: long enough for a two-hour talk over an ordinary connection,
 * short enough that a source which has quietly stalled is a failure the user
 * hears about rather than a job that never ends. It travels in the payload, so
 * the limit that applied when the run was confirmed is the one the worker
 * enforces even if this constant changes before the job runs (§8.2).
 */
export const ACQUIRE_TIMEOUT_MS = 40 * 60 * 1000;

/**
 * Credits held for an acquisition: **none**.
 *
 * `04-pricing-and-monetization.md` bills transcription and rendering. Fetching
 * the source is the cost of accepting a link at all and is priced into the plan
 * — the same reasoning `MEDIA_JOB_QUOTES` gives for probe and proxy. The call
 * still goes through admission control, which is what a nonzero-cost queue needs
 * from it anyway: one lane per workspace, so a run cannot open twenty downloads.
 */
export const ACQUIRE_QUOTE_TENTHS = 0;

/**
 * The filename an acquired source is recorded under.
 *
 * Ours, never the source's. A remote title is display text (`sourceDisplay`);
 * letting it name a file puts an attacker-chosen string into a path, a
 * `Content-Disposition` header and an export bundle.
 */
export const ACQUIRED_FILENAME = "source.mp4";
export const ACQUIRED_MIME = "video/mp4";

/** Default AI suggestions when the caller does not say (master plan §3.3). */
export const DEFAULT_REQUESTED_CANDIDATES = 5;

/** Default candidate duration window; the hard limits are 3-180 s (§6.3). */
export const DEFAULT_MIN_CANDIDATE_MS = 15_000;
export const DEFAULT_MAX_CANDIDATE_MS = 60_000;

/** List page size, and its ceiling. */
export const RUN_PAGE_SIZE = 20;
export const RUN_PAGE_MAX = 50;

/**
 * The `media.clip` output profile. `"2"` (2026-09-25): a clean 9:16 picture.
 * `"1"` burned Arial captions into the mezzanine, under every caption the clip
 * project's editor drew. In the job key, so a re-cut is never deduplicated
 * against an old-profile cut still in flight.
 */
export const CLIP_PROFILE_VERSION = "2";
