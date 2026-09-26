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
  uploadMissing: "repurpose/upload_missing",
  transcriptUntimed: "repurpose/transcript_untimed",
} as const;

/**
 * Statuses a run holds before it has moments to pick from — the stretch the
 * source, transcription and discovery producers own.
 *
 * Every write those producers make is conditional on the run still being in
 * here, so none of them can drag a run back: a discovery that completes after
 * the person already cut a clip, or a failure that lands after they pressed
 * Stop, finds the run elsewhere and changes nothing. `analyzing` is included so
 * a re-drive of discovery (the reconciler, a retry) still passes.
 */
export const PRE_CANDIDATE_STATUSES = [
  "draft",
  "acquiring",
  "preparing_media",
  "transcribing",
  "analyzing",
] as const;

/** Statuses nothing moves a run out of again, apart from a retry out of `failed`. */
export const SETTLED_RUN_STATUSES = [
  "failed",
  "cancelled",
  "published",
  "partially_published",
] as const;

/**
 * How often a READ of a run may also reconcile it (`RepurposeReconciler`). The
 * run page polls every few seconds and the home page lists every run; each
 * reconcile is a handful of queries and possibly an admission check, and the
 * durable state it reads does not change that often.
 */
export const RECONCILE_INTERVAL_MS = 5_000;

/**
 * How long reads leave a run alone after the job queue itself refused one of
 * its enqueues. Every attempt while Redis is down writes a dead job row (and,
 * for a transcription, a credit reserve and its release) before the queue says
 * no, so retrying on every 5 s poll for the length of an outage is bloat that
 * cannot succeed. A full plan lane writes nothing and is not backed off.
 */
export const QUEUE_DOWN_BACKOFF_MS = 60_000;

/**
 * How many runs one list read reconciles at once. The home page lists up to
 * `RUN_PAGE_MAX` runs, and each reconcile is several queries: all of them at
 * once, on every poll, is enough to exhaust the pool on this one-laptop API
 * and time out requests that have nothing to do with runs.
 */
export const LIST_RECONCILE_CONCURRENCY = 3;

/**
 * How often the API's own watchdog reconciles every run that has not settled
 * (`RepurposeReconciler`), unless `REPURPOSE_RECONCILE_INTERVAL_MS` says
 * otherwise.
 *
 * Reads and completions reconcile a run too, but work refused "for now" — a
 * transcription or a clip the plan's two-job lane turned away, a fetch refused
 * while the lane was full — has no completion of its own to wake it, so it only
 * moved when somebody next opened a page, while the page promised "You can
 * leave this page — we'll keep working". The scheduled sweep that would have
 * covered it never runs here (`MONTAJ_SCHEDULER_DISABLED=1`), so this is an
 * in-process timer that does not depend on the scheduler.
 */
export const DEFAULT_RECONCILE_WATCHDOG_MS = 30_000;

/** Below this the watchdog would only hammer the database; a smaller setting is raised to it. */
const MIN_RECONCILE_WATCHDOG_MS = 1_000;

/**
 * The watchdog's interval, from `REPURPOSE_RECONCILE_INTERVAL_MS`. `0` turns it
 * off (the test setup does, so an e2e app never reconciles behind a suite's
 * back); unset or unreadable is the default.
 *
 * Read from `process.env` rather than the validated `Env`, like
 * `MONTAJ_SCHEDULER_DISABLED` and `NOTIFY_WORKER_ENABLED`: it switches a
 * background loop in this process on or off, it is not product configuration.
 * Default on, because a deployment that forgets it would quietly go back to
 * runs that only move while someone is looking.
 */
export function reconcileWatchdogIntervalMs(source: NodeJS.ProcessEnv = process.env): number {
  const raw = source["REPURPOSE_RECONCILE_INTERVAL_MS"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_RECONCILE_WATCHDOG_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_RECONCILE_WATCHDOG_MS;
  if (value === 0) return 0;
  return Math.max(MIN_RECONCILE_WATCHDOG_MS, Math.floor(value));
}

/**
 * The most runs one watchdog pass looks at, newest first. Each is a handful of
 * queries, one after another; a pass over a few hundred is seconds, and a
 * backlog larger than this is a sign of something the watchdog cannot fix.
 */
export const RECONCILE_WATCHDOG_MAX_RUNS = 200;

/**
 * How long a run-level job may stay `running` before the reconciler reads it as
 * lost (2026-09-26). Production runs no scheduler, so a worker that died, a job
 * BullMQ failed for stalling twice (no callback), or a final report lost to an
 * API restart used to leave the run on "Creating the transcript" for good, with
 * a lane slot — and for a transcription a credit hold — taken the whole time.
 *
 * The probe, the proxy, the transcription and discovery each scale with the
 * video: an hour, plus twice its length. A download has its own deadline in its
 * payload (`limits.timeoutMs`), which the worker enforces; ten minutes past it,
 * the worker is gone. A job still `queued` is measured against the plan's own
 * queue wait (`jobs.max_queue_wait_ms`), which is what the scheduled
 * queue-timeout task would have failed it for.
 */
export const STAGE_RUNNING_BASE_MS = 60 * 60_000;
export const STAGE_RUNNING_PER_MEDIA_MS = 2;
export const ACQUIRE_RUNNING_MARGIN_MS = 10 * 60_000;

/**
 * How long an upload run waits for its file (2026-09-26). Its media row is made
 * by the browser's upload queue, which resumes from IndexedDB, so a closed tab
 * is not an abandoned upload — but an upload that never started, was refused,
 * failed and was dismissed, or matched a file already in the workspace (which
 * makes no row in this run's project) never arrives. A day is long enough for
 * any resume; past it the run fails with `repurpose/upload_missing` instead of
 * reading "Add a video to get started" with no way to add one.
 */
export const UPLOAD_WINDOW_MS = 24 * 60 * 60_000;

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
// "3" (2026-09-26): framed on the speaking face (`reframe.centerX`) and cut at
// up to 1080 x 1920 instead of a centre crop at 720 x 1280. A new version is
// what makes an existing clip re-cut on its next request.
export const CLIP_PROFILE_VERSION = "3";
