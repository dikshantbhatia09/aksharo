import { redisKeyPrefix } from "../common/redis/redis-keys.js";

import type { RateLimitRule } from "../common/guards/index.js";

/**
 * Every lifetime, size and limit the auth module uses, in one place, because a
 * number that appears twice is a number that will disagree with itself.
 *
 * Sources: CONTRACTS §5 (15-minute access token, 60 s rotation grace, 8-character
 * user code, device-code TTL ≤ 600 s), 05 §8 and THREAT-MODEL T1–T3.
 */

/** CONTRACTS §5: `exp(15m)`. */
export const ACCESS_TOKEN_TTL_SEC = 15 * 60;

/** How long a refresh family may live before the user signs in again. */
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

/** CONTRACTS §5: the previous refresh token still works for this long after rotation. */
export const REFRESH_GRACE_SEC = 60;

/** Opaque token sizes, in bytes. 32 bytes = 256 bits (brief §4). */
export const REFRESH_TOKEN_BYTES = 32;
export const DEVICE_CODE_BYTES = 32;
export const URL_TOKEN_BYTES = 32;

export const EMAIL_VERIFICATION_TTL_SEC = 24 * 60 * 60;

/** Brief §3: single-use, 15 minutes. */
export const MAGIC_LINK_TTL_SEC = 15 * 60;

/** Brief §2: OAuth state + PKCE verifier live 10 minutes. */
export const OAUTH_STATE_TTL_SEC = 10 * 60;

/**
 * The one-time code the OAuth callback hands the client in a redirect, exchanged
 * at `POST /auth/oauth/complete`. Tokens never travel in a redirect URL: browser
 * history, referrers and `aksharo://` handlers on the user's machine all see it.
 */
export const OAUTH_HANDOFF_TTL_SEC = 5 * 60;

/** RFC 8628 device grant; CONTRACTS §5 caps this at 600 s. */
export const DEVICE_CODE_TTL_SEC = 600;
export const DEVICE_POLL_INTERVAL_SEC = 5;
/** RFC 8628 §3.5: a `slow_down` adds this many seconds to the client's interval. */
export const DEVICE_SLOW_DOWN_INCREMENT_SEC = 5;
/** THREAT-MODEL T3: a cap on how many flows one address may have in flight. */
export const DEVICE_PENDING_CAP_PER_IP = 5;

/**
 * CONTRACTS §5: 8 characters, no ambiguous glyphs. 28 symbols to the power of 8 is
 * 3.8e11 codes; combined with the 10-minute TTL and the per-IP limits that is far
 * beyond what an online guesser can cover (THREAT-MODEL T3).
 */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
export const USER_CODE_LENGTH = 8;

/** Password policy (THREAT-MODEL T1). Length beats composition rules (NIST SP 800-63B). */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** argon2id parameters from the brief: 64 MiB, 3 iterations, 1 lane. */
export const ARGON2_MEMORY_KIB = 64 * 1024;
export const ARGON2_TIME_COST = 3;
export const ARGON2_PARALLELISM = 1;

/** Feature flag (`FEATURE_FLAGS_JSON`) that turns the HIBP range check on. */
export const BREACHED_PASSWORD_FLAG = "auth.breachedPasswordCheck";
/** Feature flag that turns the age gate off in a sandbox. Defaults to ON. */
export const AGE_GATE_FLAG = "auth.ageGate";

/**
 * Every Redis key this module writes lives under one prefix.
 *
 * A function rather than a constant since A23b: {@link redisKeyPrefix} is
 * `montaj` in every deployment and per-suite in a test run, which is what stops
 * two e2e suites sharing one logical Redis database from sweeping each other's
 * keys — the dev outbox most painfully (A21).
 */
export function authRedisPrefix(): string {
  return `${redisKeyPrefix()}:auth`;
}

export const redisKeys = {
  emailVerification: (tokenHash: string) => `${authRedisPrefix()}:verify:${tokenHash}`,
  magicLink: (tokenHash: string) => `${authRedisPrefix()}:magic:${tokenHash}`,
  oauthState: (state: string) => `${authRedisPrefix()}:oauth:state:${state}`,
  oauthHandoff: (codeHash: string) => `${authRedisPrefix()}:oauth:handoff:${codeHash}`,
  /** The rotation response replayed to a token presented inside the grace window. */
  refreshGrace: (previousHash: string) => `${authRedisPrefix()}:refresh:grace:${previousHash}`,
  devicePollAt: (deviceCodeHash: string) => `${authRedisPrefix()}:device:poll:${deviceCodeHash}`,
  /** Development-only mail outbox; see `AuthMailerService`. */
  devOutbox: () => `${authRedisPrefix()}:dev-outbox`,
  parentalWaitlist: () => `${authRedisPrefix()}:parental-waitlist`,
} as const;

/**
 * Rate limits (THREAT-MODEL T1, T3). `refillPerSec` is written as
 * `capacity / window`, so the comment and the number cannot drift: a full bucket
 * of `capacity` requests refills completely in `window` seconds.
 */
export const RATE_LIMITS = {
  /** 10 sign-ups per 10 minutes from one address. */
  signupIp: { name: "auth:signup:ip", by: "ip", capacity: 10, refillPerSec: 10 / 600 },
  /** 20 login attempts per 5 minutes from one address. */
  loginIp: { name: "auth:login:ip", by: "ip", capacity: 20, refillPerSec: 20 / 300 },
  /** 10 login attempts per 15 minutes against one account, wherever they come from. */
  loginAccount: { name: "auth:login:account", by: "email", capacity: 10, refillPerSec: 10 / 900 },
  magicLinkIp: { name: "auth:magic:ip", by: "ip", capacity: 5, refillPerSec: 5 / 600 },
  magicLinkAccount: { name: "auth:magic:account", by: "email", capacity: 3, refillPerSec: 3 / 900 },
  verifyEmailIp: { name: "auth:verify:ip", by: "ip", capacity: 20, refillPerSec: 20 / 600 },
  refreshIp: { name: "auth:refresh:ip", by: "ip", capacity: 60, refillPerSec: 60 / 60 },
  tokenExchangeUser: {
    name: "auth:exchange:user",
    by: "user",
    capacity: 30,
    refillPerSec: 30 / 60,
  },
  deviceCodeIp: { name: "auth:device:code:ip", by: "ip", capacity: 10, refillPerSec: 10 / 600 },
  deviceTokenIp: { name: "auth:device:token:ip", by: "ip", capacity: 120, refillPerSec: 120 / 600 },
  deviceApproveUser: {
    name: "auth:device:approve:user",
    by: "user",
    capacity: 20,
    refillPerSec: 20 / 600,
  },
  /**
   * X01 threat-model audit (T3): `GET /auth/device/code/:userCode` requires an
   * authenticated session but had no rate limit at all, so a signed-in caller
   * could grind through the 8-char user-code space to find someone else's
   * pending device grant and read its device/location details. Keyed on the
   * caller, not the IP, since the guard already requires a session.
   */
  deviceDescribeUser: {
    name: "auth:device:describe:user",
    by: "user",
    capacity: 20,
    refillPerSec: 20 / 600,
  },
  oauthStartIp: { name: "auth:oauth:start:ip", by: "ip", capacity: 20, refillPerSec: 20 / 600 },
  waitlistIp: { name: "auth:waitlist:ip", by: "ip", capacity: 5, refillPerSec: 5 / 3600 },
} as const satisfies Record<string, RateLimitRule>;

/** Error codes this module adds to the `auth/` namespace (CONTRACTS §8). */
export const AUTH_ERRORS = {
  invalidCredentials: "auth/invalid_credentials",
  invalidToken: "auth/invalid_token",
  expired: "auth/expired",
  weakPassword: "auth/weak_password",
  breachedPassword: "auth/breached_password",
  ageRestricted: "auth/age_restricted",
  emailNotVerified: "auth/email_not_verified",
  notAMember: "auth/not_a_member",
  sessionRevoked: "auth/session_revoked",
  registrationIncomplete: "auth/registration_incomplete",
  providerUnavailable: "auth/provider_unavailable",
  // RFC 8628 §3.5 device-grant polling responses.
  authorizationPending: "auth/authorization_pending",
  slowDown: "auth/slow_down",
  expiredToken: "auth/expired_token",
  accessDenied: "auth/access_denied",
} as const;

export type AuthErrorCode = (typeof AUTH_ERRORS)[keyof typeof AUTH_ERRORS];
