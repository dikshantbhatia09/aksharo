import type { RateLimitRule } from "../../common/guards/index.js";

/**
 * Learn what works (2026-10-05): the names, budgets and codes of following a
 * clip's posts and reading how they did.
 *
 * Two of the reads spend something shared with the rest of the product, so
 * their budgets are small and fixed here:
 *
 *   * **Postiz's analytics** come out of the same API key posting uses, which
 *     Postiz allows 30 requests an hour in all. Reading numbers takes at most
 *     {@link DEFAULT_POSTIZ_READS_PER_HOUR} of them (one a tick at most),
 *     never retried, and stops for as long as Postiz asks on a 429.
 *   * **YouTube's watch pages** come from the home IP every download comes
 *     from, which YouTube already rate-limits (`SourceGate`): a few pages a
 *     tick, seconds apart, and nothing while the gate is open or half-open.
 */

/**
 * The rollout flag. Off - which is what a MISSING `feature_flags` row reads as -
 * every route here answers 404 (the run's list answers `enabled: false`), the
 * refresh task leaves the workspace's posts alone, and no run is steered.
 * `repurpose_flow` must be on as well.
 */
export const PERFORMANCE_FLAG = "repurpose_performance";

/** The scheduled task. Inert until the operator adds it to `MONTAJ_SCHEDULER_TASKS`. */
export const PERFORMANCE_REFRESH_TASK = "repurpose.performance-refresh";

/** How often the task wakes. */
export const PERFORMANCE_REFRESH_TICK_MS = 10 * 60_000;

/** Postiz analytics reads per tick: one, so a tick is never a burst on the shared key. */
export const POSTIZ_READS_PER_TICK = 1;
/** Postiz analytics reads an hour, by default: a fifth of the key's 30. */
export const DEFAULT_POSTIZ_READS_PER_HOUR = 6;
/** The most an operator may raise it to (`PERFORMANCE_POSTIZ_READS_PER_HOUR`): a third. */
export const MAX_POSTIZ_READS_PER_HOUR = 10;
export const POSTIZ_READS_PER_HOUR_ENV = "PERFORMANCE_POSTIZ_READS_PER_HOUR";
/** A 429 without `Retry-After`: Postiz's window is an hour. */
export const POSTIZ_DEFAULT_PAUSE_MS = 60 * 60_000;

/** YouTube watch pages read per tick: twelve an hour at most. */
export const YOUTUBE_READS_PER_TICK = 2;
/** The pause between two page reads in one tick. */
export const YOUTUBE_READ_SPACING_MS = 3_000;

/** Due posts looked at per tick (a workspace whose flag is off is passed over). */
export const DUE_BATCH = 25;
/** A post of a workspace with the flag off is asked about again this much later. */
export const FLAG_OFF_RECHECK_MS = 24 * 60 * 60_000;

/** Postiz posts that went out, adopted per tick. */
export const ADOPT_BATCH = 200;

/** The most posts one clip may carry: a clip is one video, in a few shapes and languages. */
export const MAX_POSTS_PER_CLIP = 40;

/** The windows "What works" can be read over, in days. */
export const WHAT_WORKS_DAYS = [30, 90, 365] as const;
export type WhatWorksDays = (typeof WHAT_WORKS_DAYS)[number];
export const DEFAULT_WHAT_WORKS_DAYS: WhatWorksDays = 90;
/** Posts "What works" reads at most, newest first. */
export const WHAT_WORKS_MAX_POSTS = 2_000;

export const PERFORMANCE_ERRORS = {
  /** 404 while `repurpose_performance` or `repurpose_flow` is off. */
  disabled: "performance/not_available",
  /** 404: no such clip in this run and workspace. */
  clipNotFound: "performance/clip_not_found",
  /** 404: no such post in this run and workspace. */
  postNotFound: "performance/post_not_found",
  /** 409: that post is already recorded here (`details.postId`, `details.clipId`). */
  postExists: "performance/post_exists",
  /** 409: a post made through Postiz is followed from Postiz; it cannot be removed here. */
  postNotRemovable: "performance/post_not_removable",
  /** 400: the clip was not made in that shape. */
  shapeUnknown: "performance/shape_unknown",
  /** 400: the clip has no dub in that language. */
  languageUnknown: "performance/language_unknown",
  /** 400: a date in the future, or one before any post could exist. */
  dateInvalid: "performance/date_invalid",
  /** 400: numbers with none in them. */
  numbersEmpty: "performance/numbers_empty",
  /** 409: {@link MAX_POSTS_PER_CLIP}. */
  tooManyPosts: "performance/too_many_posts",
} as const;

/**
 * Why a measured read found nothing, stored on the post (`last_read_error`)
 * and said on the page.
 */
export const READ_ERRORS = {
  /** Postiz has no figures for the post (an empty answer). */
  empty: "performance/read_empty",
  /** Postiz or YouTube answered something this does not understand. */
  unreadable: "performance/read_unreadable",
  /** The request failed (network, deadline, a 5xx). */
  failed: "performance/read_failed",
  /** The video is private, removed, age-gated or not out yet. */
  unavailable: "performance/read_unavailable",
  /** Postiz no longer has the post, or never had its id. */
  missing: "performance/read_missing",
} as const;

/**
 * Rate limits. Adding a link or typing numbers is a person's pace; the bucket
 * is generous for that and small for anything scripted.
 */
export const PERFORMANCE_RATE_LIMITS = {
  mutate: {
    name: "repurpose:performance:user",
    by: "user",
    capacity: 120,
    refillPerSec: 120 / 3600,
  },
} as const satisfies Record<string, RateLimitRule>;

/** `PERFORMANCE_POSTIZ_READS_PER_HOUR`, within bounds; never throws. */
export function postizReadsPerHour(source: NodeJS.ProcessEnv = process.env): number {
  // eslint-disable-next-line security/detect-object-injection -- a constant env var name, not input
  const raw = Number.parseInt((source[POSTIZ_READS_PER_HOUR_ENV] ?? "").trim(), 10);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_POSTIZ_READS_PER_HOUR;
  return Math.min(raw, MAX_POSTIZ_READS_PER_HOUR);
}
