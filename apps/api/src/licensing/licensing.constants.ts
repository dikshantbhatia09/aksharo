import { redisKeyPrefix } from "../common/redis/redis-keys.js";

/** Error codes, audit actions and limits `licensing/` owns (CONTRACTS §8). */

export const LICENSING_ERRORS = {
  keyNotFound: "licensing/key_not_found",
  keyRevoked: "licensing/key_revoked",
  activationLimitReached: "licensing/activation_limit_reached",
  invalidRequest: "licensing/invalid_request",
  deviceRevoked: "licensing/device_revoked",
  leaseExpired: "licensing/lease_expired",
  nonceReused: "licensing/nonce_reused",
} as const;

export type LicensingErrorCode = (typeof LICENSING_ERRORS)[keyof typeof LICENSING_ERRORS];

export const LICENSING_AUDIT_ACTIONS = {
  keyCreated: "licensing.key.created",
  keyRevoked: "licensing.key.revoked",
  activated: "licensing.device.activated",
  heartbeat: "licensing.device.heartbeat",
} as const;

export type LicensingAuditAction =
  (typeof LICENSING_AUDIT_ACTIONS)[keyof typeof LICENSING_AUDIT_ACTIONS];

/** Offline verification window (05 §8, THREAT-MODEL T15, D27). */
export const LICENSE_OFFLINE_DAYS = 7;
export const LICENSE_OFFLINE_MS = LICENSE_OFFLINE_DAYS * 24 * 60 * 60 * 1000;

/** `AK-XXXX-XXXX-XXXX`: same alphabet as the device user code (no `0/O/1/I/L/5/S/8/B`). */
export const LICENSE_KEY_ALPHABET = "CDFGHJKMNPQRTVWXZ23469";
export const LICENSE_KEY_PREFIX = "AK";
export const LICENSE_KEY_GROUP_LENGTH = 4;
export const LICENSE_KEY_GROUPS = 3;

/** Clock skew tolerated when a client verifies a snapshot offline (D27). */
export const LICENSE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** How long a signed daily revocation snapshot is cached before recomputing. */
export const REVOCATION_SNAPSHOT_TTL_SEC = 24 * 60 * 60;

/**
 * `GET /plugins/manifest` (C10): how long the fetched channel manifest (C00's
 * `publish` output, `plugins-manifest.json`) is cached before re-fetching (brief
 * section 4: "served from the API with a 5-minute cache").
 */
export const PLUGIN_MANIFEST_CACHE_TTL_SEC = 5 * 60;

/** Which release channel `/plugins/manifest` reads by default (D65/07 §Plugins). */
export const PLUGIN_MANIFEST_CHANNEL = "stable" as const;

/** A function since A23b's `redisKeyPrefix()` is (per-suite isolation in tests). */
export const licensingRedisKeys = {
  heartbeatNonce: (deviceId: string, nonce: string) =>
    `${redisKeyPrefix()}:licensing:heartbeat-nonce:${deviceId}:${nonce}`,
  revocationSnapshot: () => `${redisKeyPrefix()}:licensing:revocation-snapshot`,
  pluginManifest: () => `${redisKeyPrefix()}:licensing:plugin-manifest`,
};
