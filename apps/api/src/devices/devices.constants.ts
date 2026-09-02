/** Error codes, audit actions `devices/` owns (CONTRACTS §8). */

export const DEVICE_ERRORS = {
  limitReached: "devices/limit_reached",
  notFound: "devices/not_found",
  revoked: "devices/revoked",
  leaseExpired: "devices/lease_expired",
} as const;

export type DeviceErrorCode = (typeof DEVICE_ERRORS)[keyof typeof DEVICE_ERRORS];

export const DEVICE_AUDIT_ACTIONS = {
  registered: "device.registered",
  renamed: "device.renamed",
  revoked: "device.revoked",
  heartbeat: "device.heartbeat",
} as const;

export type DeviceAuditAction = (typeof DEVICE_AUDIT_ACTIONS)[keyof typeof DEVICE_AUDIT_ACTIONS];

/** Entitlement lease renewed by heartbeat (04 §Entitlement enforcement, D27). */
export const DEVICE_LEASE_DAYS = 7;
export const DEVICE_LEASE_MS = DEVICE_LEASE_DAYS * 24 * 60 * 60 * 1000;
