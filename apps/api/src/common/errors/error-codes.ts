import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * Error codes are `namespace/slug` (CONTRACTS §8). The namespace is the domain
 * that owns the failure, not the HTTP layer, so a client can branch on it without
 * parsing prose: `credits/insufficient` means top up, `entitlement/upgrade_required`
 * means show the plan picker.
 *
 * The ones named in `07-api-and-contracts.md §Conventions` are spelled out here so
 * later work packages reuse the exact strings instead of inventing near-misses.
 */
export const ERROR_CODES = {
  // Generic, owned by the framework layer.
  badRequest: "common/bad_request",
  validationFailed: "common/validation_failed",
  unauthorized: "common/unauthorized",
  forbidden: "common/forbidden",
  notFound: "common/not_found",
  conflict: "common/conflict",
  payloadTooLarge: "common/payload_too_large",
  unsupportedMediaType: "common/unsupported_media_type",
  rateLimited: "common/rate_limited",
  internal: "common/internal",
  unavailable: "common/unavailable",

  // Domain codes from 07 §Conventions.
  authExpired: "auth/expired",
  creditsInsufficient: "credits/insufficient",
  creditsNeedsCredits: "credits/needs_credits",
  entitlementUpgradeRequired: "entitlement/upgrade_required",
  edgConflict: "edg/conflict",
  edgStaleOp: "edg/stale_op",
  mediaTooLarge: "media/too_large",
  exportUnsupportedInBrowser: "export/unsupported_in_browser",
  billingMandateCapExceeded: "billing/mandate_cap_exceeded",
  academyUnknownTrack: "academy/unknown_track",
  academyUnknownStep: "academy/unknown_step",
  supportTicketNotFound: "support/not_found",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Every code is `namespace/slug`, lowercase, with `_` inside each part. */
export const ERROR_CODE_PATTERN = /^[a-z][a-z0-9]*\/[a-z][a-z0-9_]*$/;

/**
 * The exception every module throws when it wants a specific code in the envelope.
 *
 * `details` reaches the client verbatim, so it carries machine-readable context
 * (`requiredPlan`, `latestRevision`, `opsSince`) and never a stack trace, a query
 * or anything a caller is not entitled to see.
 */
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode | (string & {}),
    message: string,
    // Named `httpStatus` rather than `status`: `HttpException.status` is private,
    // and shadowing it is a type error rather than an override.
    public readonly httpStatus: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super(message, httpStatus);
  }
}

/** The HTTP statuses Nest raises on its own, mapped onto our namespace. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ERROR_CODES.badRequest;
    case HttpStatus.UNAUTHORIZED:
      return ERROR_CODES.unauthorized;
    case HttpStatus.FORBIDDEN:
      return ERROR_CODES.forbidden;
    case HttpStatus.NOT_FOUND:
      return ERROR_CODES.notFound;
    case HttpStatus.CONFLICT:
      return ERROR_CODES.conflict;
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return ERROR_CODES.payloadTooLarge;
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return ERROR_CODES.unsupportedMediaType;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ERROR_CODES.rateLimited;
    case HttpStatus.SERVICE_UNAVAILABLE:
      return ERROR_CODES.unavailable;
    default:
      return status >= 500 ? ERROR_CODES.internal : ERROR_CODES.badRequest;
  }
}
