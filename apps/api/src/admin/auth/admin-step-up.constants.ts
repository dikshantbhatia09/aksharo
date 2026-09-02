import type { RateLimitRule } from "../../common/guards/rate-limit.guard.js";

/** Admin step-up/TOTP rate limits (THREAT-MODEL T1): a TOTP code is 6 digits, brute-forceable fast. */
export const ADMIN_AUTH_RATE_LIMITS = {
  totpEnrollUser: {
    name: "admin:totp:enroll:user",
    by: "user",
    capacity: 5,
    refillPerSec: 5 / 3600,
  },
  totpVerifyUser: {
    name: "admin:totp:verify:user",
    by: "user",
    capacity: 5,
    refillPerSec: 5 / 900,
  },
  stepUpUser: {
    name: "admin:step-up:user",
    by: "user",
    capacity: 5,
    refillPerSec: 5 / 900,
  },
  stepUpIp: {
    name: "admin:step-up:ip",
    by: "ip",
    capacity: 20,
    refillPerSec: 20 / 900,
  },
} as const satisfies Record<string, RateLimitRule>;

/** Error codes this module adds to the `admin/` namespace. */
export const ADMIN_AUTH_ERRORS = {
  totpNotEnrolled: "admin/totp-not-enrolled",
  totpAlreadyEnrolled: "admin/totp-already-enrolled",
  totpNotVerified: "admin/totp-not-verified",
  invalidCode: "admin/invalid-totp-code",
  noActiveRoles: "admin/no-active-roles",
} as const;
