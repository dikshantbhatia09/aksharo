import { redisKeyPrefix } from "../common/redis/redis-keys.js";

import type { RateLimitRule } from "../common/guards/index.js";

/**
 * Codes, limits and Redis keys for the account surface: `/me`, `/consents` and
 * `/privacy`. One place, for the same reason A04 has `auth.constants.ts` — a
 * number written twice is a number that will disagree with itself.
 */

/** Codes these modules add to the CONTRACTS §8 namespaces. */
export const ACCOUNT_ERRORS = {
  /** The account is already scheduled for erasure; `/me` is read-only from then on. */
  accountDeleted: "user/deleted",
  /** A rights request of the same kind is already open (DPDP 30-day clock). */
  dsrInFlight: "privacy/request_in_flight",
  /** The download token is unknown, spent or expired. */
  exportNotReady: "privacy/export_not_ready",
  consentPurposeUnknown: "consent/unknown_purpose",
  /**
   * `DELETE /me` refused: the caller is the sole owner of a team or agency
   * workspace (B16 addendum, after A05's open question 4). `details.workspaces`
   * lists them; ownership must be transferred (B08) or the workspace deleted
   * first. The personal workspace is exempt — it is deleted inside the cascade.
   */
  ownerOfWorkspaces: "me/owner_of_workspaces",
} as const;

export type AccountErrorCode = (typeof ACCOUNT_ERRORS)[keyof typeof ACCOUNT_ERRORS];

/** Rate limits (THREAT-MODEL T1, applied to the account surface). */
export const ACCOUNT_RATE_LIMITS = {
  /** Building an export bundle reads a dozen tables; three an hour is generous. */
  dataExportUser: { name: "me:data-export:user", by: "user", capacity: 3, refillPerSec: 3 / 3600 },
  /** Erasure happens once. The bucket only stops a loop filling `dsr_requests`. */
  erasureUser: { name: "me:erasure:user", by: "user", capacity: 3, refillPerSec: 3 / 3600 },
  /** Consent changes are cheap but write a row each; 60 an hour stops a spinner. */
  consentUser: { name: "consents:write:user", by: "user", capacity: 60, refillPerSec: 60 / 3600 },
  /** The signed download link carries no session, so its bucket is per address. */
  exportDownloadIp: {
    name: "me:data-export:download:ip",
    by: "ip",
    capacity: 30,
    refillPerSec: 30 / 600,
  },
} as const satisfies Record<string, RateLimitRule>;

/** DPDP Rule 14 (D61): a rights request is answered within 30 days. */
export const DSR_DUE_DAYS = 30;

/**
 * How long a built export bundle stays downloadable.
 *
 * 7 days (B16 brief §2: "GET /me/data data export bundle ... signed URL,
 * 7-day expiry"), up from A05's original 1 hour — a bundle that includes a
 * media manifest can be large enough on a slow connection that an hour is
 * not generous, and DPDP Rule 14's answer window is 30 days regardless.
 */
export const DATA_EXPORT_TTL_SEC = 7 * 24 * 60 * 60;

/** Bytes of entropy in the export download token. 32 bytes = 256 bits. */
export const DATA_EXPORT_TOKEN_BYTES = 32;

/**
 * Redis keys the account modules write.
 *
 * A function since A23b, for the reason {@link redisKeyPrefix} explains.
 */
export function accountRedisPrefix(): string {
  return `${redisKeyPrefix()}:account`;
}

export const accountRedisKeys = {
  /** A built `GET /me/data` bundle, addressed by the SHA-256 of its download token. */
  dataExport: (tokenHash: string) => `${accountRedisPrefix()}:export:${tokenHash}`,
} as const;
