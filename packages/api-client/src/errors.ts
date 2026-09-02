/**
 * The client side of the error envelope (CONTRACTS §8).
 *
 * Every failure the API can express arrives as
 * `{error: {code, message, details?, requestId}}` with a `namespace/slug` code,
 * so the UI branches on `code` and never on prose. A transport failure (DNS,
 * offline, CORS) has no envelope, so it becomes `network/unreachable` — the same
 * shape, so a caller has exactly one error type to handle.
 */

/** `{error: {...}}` exactly as the API serialises it. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** Codes this package raises itself, for failures that never reach the API. */
export const CLIENT_ERROR_CODES = {
  /** The request never got a response: offline, DNS, CORS, connection reset. */
  networkUnreachable: "network/unreachable",
  /** A response arrived but was not the envelope the contract promises. */
  malformedResponse: "network/malformed_response",
  /** The request was aborted by the caller (navigation, `AbortSignal`). */
  aborted: "network/aborted",
  /** The route is only in the API once its work package lands. */
  notImplemented: "client/not_implemented",
} as const;

/** Auth codes the session layer has to act on rather than merely display. */
export const AUTH_ERROR_CODES = {
  expired: "auth/expired",
  unauthorized: "common/unauthorized",
  invalidCredentials: "auth/invalid_credentials",
  invalidToken: "auth/invalid_token",
  ageRestricted: "auth/age_restricted",
  weakPassword: "auth/weak_password",
  emailUnverified: "auth/email_unverified",
  rateLimited: "common/rate_limited",
  upgradeRequired: "entitlement/upgrade_required",
} as const;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | undefined;
  /** Seconds from a `Retry-After` header, when the API sent one. */
  readonly retryAfterMs: number | undefined;

  constructor(init: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
    requestId?: string;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
  }

  /** True when a fresh access token might make this request succeed. */
  get isExpiredSession(): boolean {
    return (
      this.status === 401 &&
      (this.code === AUTH_ERROR_CODES.expired || this.code === AUTH_ERROR_CODES.unauthorized)
    );
  }

  /** True when retrying later is the right move (rate limit, transient outage). */
  get isRetryable(): boolean {
    return (
      this.status === 429 ||
      this.status === 503 ||
      this.code === CLIENT_ERROR_CODES.networkUnreachable
    );
  }

  /** `requiredPlan` from an `entitlement/upgrade_required` envelope, if present. */
  get requiredPlan(): string | undefined {
    if (this.code !== AUTH_ERROR_CODES.upgradeRequired) return undefined;
    const details = this.details;
    if (typeof details !== "object" || details === null) return undefined;
    const plan = (details as { requiredPlan?: unknown }).requiredPlan;
    return typeof plan === "string" ? plan : undefined;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Narrow to one code without a string comparison at every call site. */
export function hasErrorCode(value: unknown, code: string): boolean {
  return isApiError(value) && value.code === code;
}

/** Parse an envelope defensively: a proxy or a CDN can answer with anything. */
export function parseErrorEnvelope(body: unknown): ErrorEnvelope["error"] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== "string" || typeof message !== "string") return undefined;
  const { details, requestId } = error as { details?: unknown; requestId?: unknown };
  return {
    code,
    message,
    ...(details === undefined ? {} : { details }),
    ...(typeof requestId === "string" ? { requestId } : {}),
  };
}
