/**
 * Public API v1 tuning (B14 §1/§2).
 */

/** `entitlements.apiAccess` — Studio and Agency only (`prisma/seed-data.ts`). */
export const API_ENTITLEMENT_FLAG = "apiAccess";

/** Token-bucket default: 60 requests/minute steady-state, burst to 120. */
export const API_KEY_DEFAULT_RATE_LIMIT = 60;
export const API_KEY_DEFAULT_BURST_LIMIT = 120;

/** Agency gets a heavier lane (brief §1: "heavier for Agency"). */
export const API_KEY_AGENCY_RATE_LIMIT = 120;
export const API_KEY_AGENCY_BURST_LIMIT = 240;

/** Rotation overlap: the old key stays live this long after `rotate()`. */
export const API_KEY_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

/** `Idempotency-Key` replay window (brief §2: "24 h store"). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_HEADER = "idempotency-key";

/** SSRF-guarded `sourceUrl` ingest (brief §3). https only, small clip-sized cap by default. */
export const SOURCE_URL_ALLOWED_CONTENT_TYPES: readonly string[] = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
];
export const SOURCE_URL_FETCH_TIMEOUT_MS = 30_000;
export const SOURCE_URL_MAX_REDIRECTS = 3;

export const PUBLIC_API_ERRORS = {
  entitlementRequired: "entitlement/upgrade_required",
  keyNotFound: "public_api/key_not_found",
  sourceUrlRejected: "public_api/source_url_rejected",
  idempotencyConflict: "public_api/idempotency_conflict",
} as const;
