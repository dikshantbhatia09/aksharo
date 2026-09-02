/** Error codes, audit actions `devices/` owns (CONTRACTS §8). */

export const DEVICE_ERRORS = {
  limitReached: "devices/limit_reached",
  notFound: "devices/not_found",
  revoked: "devices/revoked",
  leaseExpired: "devices/lease_expired",
} as const;

export type DeviceErrorCode = (typeof DEVICE_ERRORS)[keyof typeof DEVICE_ERRORS];

/**
 * `POST /devices/{id}/bridge-token` (B08b): these mirror `licensing/`'s own
 * `deviceRevoked` code exactly (same failure, same wording a plugin already
 * handles) and add the one licensing has no equivalent for — the B08 device
 * lease itself, as opposed to a licence key's offline window.
 */
export const BRIDGE_TOKEN_ERRORS = {
  deviceRevoked: "licensing/device_revoked",
  deviceLeaseExpired: "licensing/device_lease_expired",
} as const;

export type BridgeTokenErrorCode = (typeof BRIDGE_TOKEN_ERRORS)[keyof typeof BRIDGE_TOKEN_ERRORS];

export const DEVICE_AUDIT_ACTIONS = {
  registered: "device.registered",
  renamed: "device.renamed",
  revoked: "device.revoked",
  heartbeat: "device.heartbeat",
  bridgeTokenIssued: "device.bridge_token_issued",
} as const;

export type DeviceAuditAction = (typeof DEVICE_AUDIT_ACTIONS)[keyof typeof DEVICE_AUDIT_ACTIONS];

/** Entitlement lease renewed by heartbeat (04 §Entitlement enforcement, D27). */
export const DEVICE_LEASE_DAYS = 7;
export const DEVICE_LEASE_MS = DEVICE_LEASE_DAYS * 24 * 60 * 60 * 1000;
