import type { RateLimitRule } from "../../common/guards/index.js";

/**
 * Set-and-forget clips (2026-10-02): the names, limits and codes of channel
 * automations ("watches") and of starting several runs at once.
 *
 * Everything here is deliberately small. A watch reads one public feed an hour
 * from the same home IP every download comes from, and that IP is what
 * YouTube rate-limits (`SourceGate`): the budgets below are what keep an
 * automation from ever being the reason the rest of the product waits.
 */

/**
 * The rollout flag. Off - which is what a MISSING `feature_flags` row reads as
 * (`EntitlementService.activeFlags` only lists rows that exist) - every route
 * here answers 404 and the poller leaves the workspace's watches alone.
 * `repurpose_flow` and `source_youtube_acquire` must be on as well: a watch
 * starts link runs, and those two are what a link run needs.
 */
export const AUTOMATIONS_FLAG = "repurpose_automations";

/** The scheduled task. Inert until the operator adds it to `MONTAJ_SCHEDULER_TASKS`. */
export const SOURCE_WATCH_TASK = "repurpose.source-watch";

/** How often the task wakes. A watch itself is read far less often ({@link WATCH_CHECK_EVERY_MS}). */
export const SOURCE_WATCH_TICK_MS = 15 * 60_000;

/** The least time between two reads of one watch's feed. */
export const WATCH_CHECK_EVERY_MS = 60 * 60_000;

/**
 * Up to this much is added to each watch's next check, at random, so watches
 * made in the same minute do not stay in step and read their feeds in a burst.
 * Always added, never subtracted: a watch is read at most once an hour.
 */
export const WATCH_CHECK_JITTER_MS = 15 * 60_000;

/** After a failed read, the wait doubles per failure in a row, up to a day. */
export const WATCH_RETRY_MAX_MS = 24 * 60 * 60_000;

/**
 * Feeds read per tick, oldest due first. Four ticks an hour make at most 80
 * requests an hour however many watches exist; the rest wait their turn.
 */
export const WATCHES_PER_TICK = 20;

/** The pause between two feed reads in one tick: a polite client, not a burst. */
export const WATCH_FETCH_SPACING_MS = 2_000;

/** Runs one check may start for one watch; more new videos wait for the next check. */
export const WATCH_STARTS_PER_CHECK = 2;

/** A watch per workspace is one more feed an hour; this bounds a workspace's share. */
export const MAX_WATCHES_PER_WORKSPACE = 20;

/** "Also make clips of my latest N videos", chosen when the watch is made. */
export const MAX_BACKFILL = 3;

/**
 * A new video found this long after it was published is recorded as too old
 * rather than started: after a long pause, an outage or checks switched off
 * for a week, a watch must not start a burst of runs (and spend their credits)
 * for videos nobody is waiting on. The latest-N videos asked for at creation
 * are exempt; they were asked for by name.
 */
export const WATCH_MAX_VIDEO_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * A feed entry with no views yet is most likely a premiere or a live stream
 * that has not happened: it is left for later checks for this long before it
 * is recorded as skipped. A real new upload has views within the hour.
 */
export const WATCH_UPCOMING_WAIT_MS = 7 * 24 * 60 * 60_000;

/** A claim (`starting`) older than this is looked into: its run exists, or it is pending again. */
export const WATCH_CLAIM_STALE_MS = 10 * 60_000;

/** Starts of one video that failed for a reason worth trying again, before it is given up on. */
export const WATCH_START_ATTEMPTS = 3;

/** Feed reads in a row that found no such channel before the watch says so and stops. */
export const WATCH_NOT_FOUND_LIMIT = 3;

/** The video ids a watch's cursor remembers, newest first. A feed lists about 15. */
export const WATCH_CURSOR_MAX = 100;

/** Links one "Several links" request may carry. */
export const BULK_MAX_LINKS = 20;

/** Why a watch is paused or in error. `person` is a person's own pause. */
export const WATCH_STATE_REASONS = [
  "person",
  "no_credits",
  "creator_left",
  "style_unknown",
  "setup_invalid",
  "channel_not_found",
] as const;
export type WatchStateReason = (typeof WATCH_STATE_REASONS)[number];

/** What the page says for each reason. */
export const WATCH_STATE_MESSAGES: Readonly<Record<WatchStateReason, string>> = Object.freeze({
  person: "Paused. New videos are not picked up until you resume it.",
  no_credits:
    "Paused: this workspace ran out of credits. Add credits, then resume it to pick up where it left off.",
  creator_left:
    "Paused: the person who set this up is no longer an editor here. Remove it and connect the channel again to take it over.",
  style_unknown:
    "Paused: its caption look is no longer available. Choose another in its settings, then resume it.",
  setup_invalid: "Paused: its settings need another look. Save them again, then resume it.",
  channel_not_found:
    "This channel could not be found on YouTube. If it is back, resume the automation to try again.",
});

/** Why a video a watch found was not started. */
export const WATCH_SKIP_REASONS = ["short", "too_old", "upcoming", "already_running"] as const;

export const AUTOMATION_ERRORS = {
  /** 404 while the flag (or `repurpose_flow` / `source_youtube_acquire`) is off. */
  disabled: "repurpose/automations_not_available",
  notFound: "repurpose/watch_not_found",
  /** 400: not a YouTube channel link. */
  channelUrlInvalid: "repurpose/channel_url_invalid",
  /** 404 from YouTube: no such channel. */
  channelNotFound: "repurpose/channel_not_found",
  /** 503: YouTube is refusing this server right now (`SourceGate`), or did just now. */
  youtubeBusy: "repurpose/youtube_busy",
  /** 502: the channel's page or feed could not be read or understood. */
  channelUnreadable: "repurpose/channel_unreadable",
  /** 409: this workspace already watches the channel (`details.watchId`). */
  watchExists: "repurpose/watch_exists",
  /** 409: {@link MAX_WATCHES_PER_WORKSPACE}. */
  watchLimit: "repurpose/watch_limit",
  /** 400: a setup a watch cannot run with (a picked start, manual moments). */
  setupInvalid: "repurpose/watch_setup_invalid",
  /** 409 on resume: the person it runs as has left; connect the channel again. */
  creatorGone: "repurpose/watch_creator_gone",
  /** 400 on the bulk route: no usable link in the request. */
  noLinks: "repurpose/bulk_no_links",
} as const;

/**
 * Rate limits. Resolving a channel is a request to YouTube, so it is kept to
 * what a person adding channels by hand does; the cache in front of it makes a
 * repeated preview free. A bulk request is one bucket token for the request and
 * one `repurpose:create:user` token per run it starts, so the per-person ceiling
 * on new runs holds however they are started.
 */
export const AUTOMATION_RATE_LIMITS = {
  resolve: {
    name: "repurpose:watch-resolve:user",
    by: "user",
    capacity: 20,
    refillPerSec: 20 / 3600,
  },
  mutate: {
    name: "repurpose:watch:user",
    by: "user",
    capacity: 60,
    refillPerSec: 60 / 3600,
  },
  bulk: {
    name: "repurpose:bulk:user",
    by: "user",
    capacity: 5,
    refillPerSec: 5 / 3600,
  },
} as const satisfies Record<string, RateLimitRule>;
