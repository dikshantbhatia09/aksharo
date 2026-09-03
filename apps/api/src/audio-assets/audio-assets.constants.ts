import type { RateLimitRule } from "../common/guards/index.js";

/** Error codes for the `audio-assets` HTTP surface (D04d). */
export const AUDIO_ASSET_ERRORS = {
  notFound: "audio-assets/not_found",
  notAllowed: "audio-assets/not_allowed",
} as const;

/**
 * How long a pack-asset signed URL stays valid: brief §1 pins it at ten
 * minutes — long enough for `OfflineAudioContext` to fetch and decode a cue
 * (seconds, not the multi-gigabyte proxies `DOWNLOAD_URL_TTL_SECONDS` signs
 * for) without inviting a URL to be cached and replayed long after the
 * caller's session ended.
 */
export const PACK_ASSET_URL_TTL_SECONDS = 10 * 60;

/**
 * The read is audit-free (brief §1: previewing a cue is not a placement
 * event — `AssetUsage` rows are written when a pass accepts an item, not on
 * every preview fetch) but still rate-limited: sixty a minute per user is
 * far more than a Passes-tab session ever needs (previewing every catalogue
 * candidate once) and small enough that a scripted enumeration of asset ids
 * costs meaningfully more than a browser dragging the same cue-list scrubber.
 */
export const AUDIO_ASSET_RATE_LIMITS = {
  url: { name: "audio-assets:url:user", by: "user", capacity: 60, refillPerSec: 60 / 60 },
} as const satisfies Record<string, RateLimitRule>;
