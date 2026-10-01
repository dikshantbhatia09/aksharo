/**
 * The voice-over hook's names, limits and switches (2026-10-01, OpusClip
 * parity wave 4).
 */

/**
 * The feature flag. NOT created by any migration or seed: until an operator
 * creates it, it is off for everyone, and every write answers 403
 * `voiceover/not_enabled`. `repurpose_flow` must be on as well. The owner turns
 * it on with:
 *
 *     node _orchestration/tools/ops-flag.cjs repurpose_voiceover owner \
 *       "Voice-over hook: owner trial" \
 *       "A spoken hook at the start of a clip (Sarvam text-to-speech, paid per character)"
 *
 * (`everyone` / `paid` / `off` as for any flag; a change shows within 60 s.)
 */
export const VOICEOVER_FLAG = "repurpose_voiceover";

/**
 * Refusals and failures a voice-over is named by; each is one sentence on the
 * run page (`apps/web/components/repurpose/voiceover/copy.ts`). Only the
 * vendor's refusal (`vendorRefused`) carries the vendor's own words.
 */
export const VOICEOVER_ERRORS = {
  /** 403: the flag is off for this workspace. */
  notEnabled: "voiceover/not_enabled",
  notFound: "voiceover/not_found",
  /** The clip is not made yet, or none of its shapes has an editing document. */
  clipNotReady: "voiceover/clip_not_ready",
  clipRemoved: "voiceover/clip_removed",
  runStopped: "voiceover/run_stopped",
  /** No words to say: the clip has no hook line and none was given. */
  noText: "voiceover/no_text",
  /** The clip's language is not one the voice speaks. */
  languageUnsupported: "voiceover/language_unsupported",
  /** The clip already has a voice-over being made or on it. */
  alreadyHas: "voiceover/already_has",
  tooMany: "voiceover/too_many",
  budgetReached: "voiceover/budget_reached",
  budgetUnavailable: "voiceover/budget_unavailable",
  noCredits: "voiceover/no_credits",
  notRetryable: "voiceover/not_retryable",
  notRemovable: "voiceover/not_removable",

  // What a voice-over ends on (worker-reported, or the API's own).
  vendorRefused: "voiceover/vendor_refused",
  vendorAuth: "voiceover/vendor_auth",
  notConfigured: "voiceover/not_configured",
  tooLong: "voiceover/too_long",
  resultMismatch: "voiceover/result_mismatch",
  failed: "voiceover/failed",
} as const;

/** A refusal the same request would get again: no Retry is offered. */
export const NOT_RETRYABLE_FAILURES: ReadonlySet<string> = new Set([
  VOICEOVER_ERRORS.vendorRefused,
  VOICEOVER_ERRORS.tooLong,
]);

/** Failure codes whose message is the vendor's own words, shown as they are. */
export const VENDOR_WORDS: ReadonlySet<string> = new Set([VOICEOVER_ERRORS.vendorRefused]);

/** Voice-overs one workspace may have waiting or being spoken at once. */
export const MAX_LIVE_VOICEOVERS_PER_WORKSPACE = 5;

/** How many live (or freshly made) voice-overs one watchdog sweep looks at. */
export const VOICEOVER_SWEEP_BATCH = 50;

/**
 * How long after a voice-over is made the watchdog keeps laying it on shapes
 * cut later (Autopilot's 4:5, 1:1 and 16:9 arrive after the 9:16). A read of
 * the run's voice-overs places it at any age.
 */
export const VOICEOVER_PLACE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The speaking rate every voice-over is made at (the vendor's natural pace). */
export const VOICEOVER_PACE = 1;

/** The voice a request without one gets. */
export const DEFAULT_VOICEOVER_SPEAKER = "anushka";

/** Signed URLs on the list: long enough to listen, refetched far more often. */
export const VOICEOVER_URL_TTL_SECONDS = 3_600;
