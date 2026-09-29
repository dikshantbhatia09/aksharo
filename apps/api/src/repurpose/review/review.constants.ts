import type { BucketSpec, RateLimitRule } from "../../common/guards/index.js";

/**
 * Clip review (2026-10-03): codes, limits and timings.
 *
 * Numbers live here rather than in the environment for the reason
 * `share.constants.ts` gives: they are product decisions, not per-deployment
 * tuning.
 */

/** Refusals the review routes raise. Each carries a sentence a person can act on. */
export const REVIEW_ERRORS = {
  /** 404: no such clip in this run and workspace (or it was removed). */
  clipNotFound: "review/clip_not_found",
  /** 404: no such comment on this clip. */
  commentNotFound: "review/comment_not_found",
  /** 409: approval needs a finished captioned video to approve. */
  noVideo: "review/no_video",
  /** 409: the videos changed after the page showed them; look again first. */
  videoChanged: "review/video_changed",
  /** 409: another decision landed at the same moment; try again. */
  busy: "review/busy",
  /** 403: this role may not make this decision (or resolve someone else's comment). */
  forbidden: "review/forbidden",
  /** 400: this link asks for the reviewer's name. */
  nameRequired: "review/name_required",
  /** 404: no such review link (public), or not in this run (team). */
  linkNotFound: "review/link_not_found",
  /** 410: the link was revoked. */
  linkRevoked: "review/link_revoked",
  /** 410: the link is past its expiry. */
  linkExpired: "review/link_expired",
  /** 409: a run has at most {@link MAX_LINKS_PER_RUN} live links. */
  tooManyLinks: "review/too_many_links",
} as const;

/** A review link lives 1 to 30 days; 7 unless asked. */
export const LINK_MIN_DAYS = 1;
export const LINK_MAX_DAYS = 30;
export const LINK_DEFAULT_DAYS = 7;

/** Live (unrevoked, unexpired) links one run may have at once. */
export const MAX_LINKS_PER_RUN = 20;

/** Longest comment, and the note a request for changes carries. */
export const COMMENT_MAX = 2_000;
/** Longest name a client may give. */
export const NAME_MAX = 60;
/** Longest label the team gives a link. */
export const LABEL_MAX = 80;
/** The most comments one clip lists (a thread past this is a support case, not a review). */
export const COMMENTS_PER_CLIP_MAX = 500;
/** The most history rows one clip lists. */
export const EVENTS_PER_CLIP_MAX = 100;

/**
 * How long the review page's video URLs are signed for. Short, as the brief
 * asks of a page anyone with the link can open: long enough to watch a clip
 * through, and the page asks again every few minutes (`useStableUrl` holds a
 * playing video's URL for three quarters of this, then takes a fresh one).
 */
export const PUBLIC_VIDEO_URL_TTL_SECONDS = 20 * 60;

/** The team's own video URLs: the run page's hour, as its clip URLs have. */
export const MEMBER_VIDEO_URL_TTL_SECONDS = 60 * 60;

/** A page load at least this long after the last one counts as a new visit. */
export const VISIT_GAP_MS = 30 * 60_000;

/**
 * Comments on one clip tell the run's creator at most once per this: a client
 * leaving ten notes in a row is one notification, not ten.
 */
export const COMMENT_NOTICE_GAP_MS = 10 * 60_000;

/** The shape a client reviews: the vertical video, the one every platform takes. */
export const CLIENT_SHAPE = "9:16" as const;

export const REVIEW_RATE_LIMITS = {
  /** A member's decisions, comments and link changes. */
  mutate: {
    name: "review:mutate:user",
    by: "user",
    capacity: 240,
    refillPerSec: 240 / 3600,
  },
  /** Opening the review page: the unauthenticated surface an attacker can hit for free. */
  publicRead: {
    name: "review:read:ip",
    by: "ip",
    capacity: 60,
    refillPerSec: 60 / 60,
  },
  /**
   * A client's decisions and comments. Generous enough for one person to go
   * through a run of 40 clips twice; bounded so the link cannot be used to flood
   * a workspace with notes.
   */
  publicWrite: {
    name: "review:write:ip",
    by: "ip",
    capacity: 120,
    refillPerSec: 120 / 3600,
  },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Writes through one link, whatever address they come from: the per-IP bucket
 * alone would let a link that leaked be used from many addresses at once.
 */
export const LINK_WRITE_BUCKET: BucketSpec = {
  name: "review:write:link",
  capacity: 300,
  refillPerSec: 300 / 3600,
};
