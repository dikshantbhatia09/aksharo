/**
 * Posting clips through Postiz (2026-09-29): flags, codes and timings.
 */

/** Rollout flags, seeded off (`prisma/seed-data.ts`). */
export const PUBLISHING_FLAGS = {
  /** The whole surface. Off: the routes answer 404 and the page shows no Post button. */
  postiz: "publishing_postiz",
  /** TikTok on top: off, TikTok channels are listed but cannot be picked. */
  tiktok: "publishing_tiktok",
  /** The run surface itself; a clip is only ever posted from a run. */
  repurpose: "repurpose_flow",
} as const;

/** Refusals the routes raise. Each carries a sentence a person can act on. */
export const PUBLISHING_ERRORS = {
  /** 404: the flag is off for this workspace. */
  disabled: "publishing/disabled",
  /** 503: no Postiz key, or this workspace is not one allowed to use it. */
  notConfigured: "publishing/not_configured",
  /** 503: Postiz is down or refused the key. */
  unavailable: "publishing/unavailable",
  /** 404: no such clip in this run and workspace. */
  clipNotFound: "publishing/clip_not_found",
  /** 400: a channel id this workspace does not have (or not any more). */
  channelUnknown: "publishing/channel_unknown",
  /** 400: a channel Aksharo does not post to, a disabled one, or TikTok while its flag is off. */
  channelUnavailable: "publishing/channel_unavailable",
  /** 409: no finished captioned video in a shape the platform takes, or too long for it. */
  notReady: "publishing/not_ready",
  /** 400: the text does not fit the platform. */
  textInvalid: "publishing/text_invalid",
  /** 400: a time in the past, too far ahead, or an unknown time zone. */
  timeInvalid: "publishing/time_invalid",
  /** 409: that clip already has a live post on that account for that slot. */
  alreadyPosted: "publishing/already_posted",
  /** 404: no such post in this workspace. */
  postNotFound: "publishing/post_not_found",
  /** 409: a post that is being sent right now, or is already out. */
  notCancellable: "publishing/not_cancellable",
  /** 409: a post that has not failed, or failed for a reason retrying cannot fix. */
  notRetryable: "publishing/not_retryable",
  /**
   * 409 (2026-10-03): the workspace needs approval before posting, and this clip
   * is not approved - or its video changed after it was, so what would go out is
   * not what was approved (`repurpose/review/clip-approval.gate.ts`).
   */
  notApproved: "publishing/not_approved",
} as const;

/** A scheduled time must leave Postiz a moment to take it. */
export const MIN_SCHEDULE_LEAD_MS = 2 * 60_000;
/** And be within a year: Postiz holds it that long, the video longer than that is unlikely. */
export const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60_000;
/** "One a day" leaves at least this before the first slot, or starts the next day. */
export const DAILY_MIN_LEAD_MS = 15 * 60_000;

/** How long the list of channels from Postiz is trusted before asking again. */
export const CHANNEL_CACHE_MS = 60_000;

/**
 * Automatic tries of one post, counting the first, for the failures that are
 * passing by nature: Postiz busy or rate-limited, the connection lost before
 * the post was accepted. After them, the post waits for a person's Retry.
 */
export const AUTO_ATTEMPTS = 3;
/** The wait before an automatic retry: this, doubled per attempt, plus jitter. */
export const RETRY_BASE_MS = 60_000;

/**
 * Reconciling a post Postiz has accepted.
 *
 * A post going out now is checked quickly at first (a Reel takes Instagram a
 * minute or two), then less often; a post scheduled days ahead is looked at
 * once a day - to notice it being deleted or moved in Postiz - and then right
 * after its time. Checks are bounded ({@link MAX_CHECKS}); past them, or past
 * {@link MAX_PROCESSING_MS} of "still posting", the post asks for a person
 * instead of being polled forever (master plan §8.7).
 */
export const FIRST_CHECK_MS = 30_000;
export const MAX_CHECK_GAP_MS = 10 * 60_000;
export const SCHEDULED_CHECK_GAP_MS = 24 * 60 * 60_000;
export const AFTER_DUE_CHECK_MS = 90_000;
export const MAX_CHECKS = 90;
export const MAX_PROCESSING_MS = 2 * 60 * 60_000;
/**
 * An unanswered submit: how many checks find nothing before it counts as never
 * accepted. Five checks is about eight minutes: Postiz writes the post before it
 * answers, and a request still being handled after that long is not plausible.
 */
export const UNCERTAIN_CHECKS = 5;

/** How often the watchdog looks for work whose job was lost (a restart, Redis). */
export const WATCHDOG_INTERVAL_MS = 30_000;
/** Posts the watchdog handles per pass. */
export const WATCHDOG_BATCH = 50;
/** A `ready` post younger than this is left to the job its confirmation enqueued. */
export const READY_GRACE_MS = 45_000;

/** BullMQ worker concurrency: uploads one at a time, checks two. */
export const DISPATCH_CONCURRENCY = 1;
export const RECONCILE_CONCURRENCY = 2;
