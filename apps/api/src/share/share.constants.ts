import type { RateLimitRule } from "../common/guards/index.js";

/**
 * Error codes, hygiene limits and rate rules for `share-links`, the public `/s/:token`
 * viewer and `comments` (B15 brief §1–3).
 *
 * Numbers live here rather than in the environment, same reasoning as
 * `projects.constants.ts`: these are product decisions (F-501–F-504), not
 * per-deployment tuning.
 */
export const SHARE_ERRORS = {
  notFound: "share/not_found",
  revoked: "share/revoked",
  expired: "share/expired",
  viewLimitReached: "share/view_limit_reached",
  passwordRequired: "share/password_required",
  passwordIncorrect: "share/password_incorrect",
  scopeForbidden: "share/scope_forbidden",
  invalidCategory: "share/invalid_category",
} as const;

export const COMMENT_ERRORS = {
  notFound: "comment/not_found",
  parentNotFound: "comment/parent_not_found",
  guestNameRequired: "comment/guest_name_required",
} as const;

/** Base62: no ambiguous-character exclusions needed since case carries entropy. */
export const SHARE_TOKEN_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Brief §1: "token 22+ chars base62". 24 gives >142 bits of entropy. */
export const SHARE_TOKEN_LENGTH = 24;

/**
 * Header carrying a share link's unlocked-password session (F-501). A header
 * rather than a cookie: the API sets no cookie-parsing middleware anywhere else
 * (07 §Conventions — bearer tokens throughout), and the viewer already needs to
 * hold the value in memory to replay it on the CanvasKit/export fetches.
 */
export const SHARE_SESSION_HEADER = "x-share-session";
export const SHARE_SESSION_TTL_SECONDS = 60 * 60 * 24; // 24h

/**
 * F-504: "automatic disable after N reports pending review". Pending means
 * `resolvedAt IS NULL` — a report an admin has already dismissed does not count
 * against the link.
 */
export const SHARE_AUTO_DISABLE_REPORT_THRESHOLD = 3;

/** IT Rules intermediary-hygiene SLA (also read by `ShareReportSlaTask`, B16). */
export const SHARE_REPORT_SLA_HOURS: Record<"ncii" | "other", number> = {
  ncii: 3,
  other: 36,
};

export const SHARE_RATE_LIMITS = {
  /** Creating share links from the editor. */
  createLink: {
    name: "share:create:user",
    by: "user",
    capacity: 60,
    refillPerSec: 60 / 3600,
  },
  /** The public viewer resolving a token — the surface an attacker can hit. */
  resolveToken: {
    name: "share:resolve:ip",
    by: "ip",
    capacity: 30,
    refillPerSec: 30 / 60,
  },
  /** Password attempts against one link, throttled harder than a plain resolve. */
  unlockToken: {
    name: "share:unlock:ip",
    by: "ip",
    capacity: 10,
    refillPerSec: 10 / 300,
  },
  /** Report-abuse submission: generous but bounded so it cannot be used as a DoS. */
  reportAbuse: {
    name: "share:report:ip",
    by: "ip",
    capacity: 10,
    refillPerSec: 10 / 3600,
  },
  /** Guest comments through a public link. */
  postComment: {
    name: "share:comment:ip",
    by: "ip",
    capacity: 30,
    refillPerSec: 30 / 3600,
  },
} as const satisfies Record<string, RateLimitRule>;

export const COMMENT_BODY_MAX = 4000;
export const COMMENTS_MAX_PAGE_SIZE = 200;
