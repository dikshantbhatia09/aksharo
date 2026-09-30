import type { BucketSpec, RateLimitRule } from "../../common/guards/index.js";

/**
 * Guest pages (2026-10-05): codes, limits and timings.
 *
 * Numbers live here rather than in the environment for the reason
 * `review.constants.ts` gives: they are product decisions, not per-deployment
 * tuning. The token rules and the rate limits are the client review links'
 * (`repurpose/review`), under names of their own so the two surfaces never
 * share a bucket.
 */

/** Refusals the guest routes raise. Each carries a sentence a person can act on. */
export const GUEST_ERRORS = {
  /** 404: no such guest link (public), or not in this run (team). */
  linkNotFound: "guest/link_not_found",
  /** 410: the link was revoked. */
  linkRevoked: "guest/link_revoked",
  /** 410: the link is past its expiry. */
  linkExpired: "guest/link_expired",
  /** 409: a run has at most {@link MAX_GUEST_LINKS_PER_RUN} live guest links. */
  tooManyLinks: "guest/too_many_links",
  /** 400: a clip asked for is not one of this run's (or was removed from it). */
  clipNotInRun: "guest/clip_not_in_run",
  /** 404: that clip is not on this guest's page. */
  clipNotFound: "guest/clip_not_found",
} as const;

/** A guest link lives 1 to 30 days; 14 unless asked. */
export const GUEST_LINK_MIN_DAYS = 1;
export const GUEST_LINK_MAX_DAYS = 30;
export const GUEST_LINK_DEFAULT_DAYS = 14;

/**
 * Live (unrevoked, unexpired) guest links one run may have at once: a podcast
 * episode has a guest or three, and a link per guest is plenty even for a
 * panel. The review links' cap, counted on its own.
 */
export const MAX_GUEST_LINKS_PER_RUN = 20;

/** The most clips one link names: a run has at most 40 (`MAX_CLIPS_PER_RUN`). */
export const MAX_CLIPS_PER_GUEST_LINK = 40;

/** Longest guest name the team may give (it is shown in the page's greeting). */
export const GUEST_NAME_MAX = 60;

/**
 * How long the page's files are signed for. Signed afresh on every page view
 * and short, as on the client review page (`PUBLIC_VIDEO_URL_TTL_SECONDS`): long
 * enough to start any download from the page, and the page asks again every
 * few minutes. A download that has started finishes past it.
 */
export const GUEST_URL_TTL_SECONDS = 20 * 60;

export const GUEST_RATE_LIMITS = {
  /** A member's link changes. */
  mutate: {
    name: "guest:mutate:user",
    by: "user",
    capacity: 120,
    refillPerSec: 120 / 3600,
  },
  /** Opening the page: the unauthenticated surface an attacker can hit for free. */
  publicRead: {
    name: "guest:read:ip",
    by: "ip",
    capacity: 60,
    refillPerSec: 60 / 60,
  },
  /**
   * A download counted: generous enough for a guest taking every shape and
   * image of a long run, bounded so the count cannot be used to fill the audit
   * trail.
   */
  publicDownload: {
    name: "guest:download:ip",
    by: "ip",
    capacity: 300,
    refillPerSec: 300 / 3600,
  },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Downloads counted through one link, whatever address they come from: the
 * per-address bucket alone would let a link that leaked be counted from many
 * addresses at once. A refusal stops the count, never the download.
 */
export const GUEST_LINK_DOWNLOAD_BUCKET: BucketSpec = {
  name: "guest:download:link",
  capacity: 600,
  refillPerSec: 600 / 3600,
};
