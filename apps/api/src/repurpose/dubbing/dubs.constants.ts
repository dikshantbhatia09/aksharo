/**
 * Dubbing's names, limits and deployment switches (2026-10-04).
 */

/**
 * The feature flag: off for everyone until an operator targets a workspace
 * (`prisma/seed-data.ts` seeds it off). `repurpose_flow` must be on as well.
 */
export const DUB_FLAG = "repurpose_dubbing";

/**
 * Refusals and failures a dub is named by. Each is one sentence on the run
 * page (`apps/web/components/repurpose/dubbing/copy.ts`); a vendor's own words
 * are only ever shown for the three the vendor wrote (`VENDOR_WORDS`).
 */
export const DUB_ERRORS = {
  /** 403: the flag is off for this workspace. */
  notEnabled: "dub/not_enabled",
  notFound: "dub/not_found",
  /** The clip is not made yet, or its 9:16 picture is not ready. */
  clipNotReady: "dub/clip_not_ready",
  clipRemoved: "dub/clip_removed",
  /** The run was stopped: nothing new is made from it. */
  runStopped: "dub/run_stopped",
  /** The voice-cloning box was not ticked. */
  consentRequired: "dub/consent_required",
  /** The clip's language is not one the vendor dubs from (or was not detected). */
  sourceUnsupported: "dub/source_unsupported",
  sameLanguage: "dub/same_language",
  /** A language asked for is already dubbed, or being dubbed, for this clip. */
  languageTaken: "dub/language_taken",
  /** Too many dubs being made in this workspace at once. */
  tooMany: "dub/too_many",
  /** Today's rupee budget for dubbing, across every workspace, is spent. */
  budgetReached: "dub/budget_reached",
  /** The budget could not be read (Redis): refused rather than trusted. */
  budgetUnavailable: "dub/budget_unavailable",
  noCredits: "dub/no_credits",
  /** Costs more than the plan may hold for work at once: fewer languages at a time. */
  planLimit: "dub/plan_limit",
  tooLong: "dub/too_long",
  notRetryable: "dub/not_retryable",
  notCancellable: "dub/not_cancellable",

  // What a dub ends on (worker-reported, or the API's own).
  vendorRefused: "dub/vendor_refused",
  vendorFailed: "dub/vendor_failed",
  vendorAuth: "dub/vendor_auth",
  /** The vendor's answer did not match what was asked (a worker bug): nothing applied. */
  resultMismatch: "dub/result_mismatch",
  /** A job that ended with no reason the page knows. */
  failed: "dub/failed",
  cancelled: "dub/cancelled",
} as const;

/** Failure codes whose message is the vendor's own words, shown as they are. */
export const VENDOR_WORDS: ReadonlySet<string> = new Set([
  DUB_ERRORS.vendorRefused,
  DUB_ERRORS.vendorFailed,
  DUB_ERRORS.vendorAuth,
]);

/**
 * Failures after which the vendor job cannot be resumed: it failed, or refused
 * the request. Every other failure resumes the same vendor job on Retry.
 */
export const DEFINITIVE_FAILURES: ReadonlySet<string> = new Set([
  DUB_ERRORS.vendorRefused,
  DUB_ERRORS.vendorFailed,
]);

/** A refusal the same request would get again: no Retry is offered. */
export const NOT_RETRYABLE_FAILURES: ReadonlySet<string> = new Set([DUB_ERRORS.vendorRefused]);

/** Dubs one workspace may have waiting or with the vendor at once. */
export const MAX_LIVE_DUBS_PER_WORKSPACE = 3;

/** Tries at laying one language under one shape before that shape is given up. */
export const DUB_MUX_ATTEMPTS = 3;

/** Failed renders of one dubbed shape's captioned video before it reads failed. */
export const DUB_RENDER_ATTEMPTS = 3;

/** How long after an edit in a dubbed project its captioned video is made again. */
export const DUB_CAPTIONED_QUIET_MS = 60_000;

/** How many live dubs one watchdog sweep looks at. */
export const DUB_SWEEP_BATCH = 50;

/** The sentence the person ticks; recorded with the consent. */
export const DUB_CONSENT_STATEMENT =
  "I have the right to use this speaker's voice, and consent to it being cloned.";
/** Its version, in the audit row: a changed sentence is a new version. */
export const DUB_CONSENT_VERSION = "2026-10-04";

/** Signed URLs on the dub list: long enough to watch, refetched far more often. */
export const DUB_URL_TTL_SECONDS = 3_600;

/**
 * `DUB_ORIGINAL_BED_DB`: keep the clip's own sound under the dub, that many dB
 * down (e.g. `-18`), for a vendor whose audio turns out to be dialogue only.
 * Unset (the default) replaces the sound with the dub, which is right when the
 * vendor's audio is the full mix - to be confirmed on the first live dub. Read
 * from the process environment like `REPURPOSE_RECONCILE_INTERVAL_MS`: an
 * operator's switch, not product configuration.
 */
export function dubOriginalBedDb(source: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = source["DUB_ORIGINAL_BED_DB"]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value <= 0 && value >= -60 ? value : undefined;
}
