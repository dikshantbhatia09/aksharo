import { HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { AppException, codeForStatus, ERROR_CODE_PATTERN, ERROR_CODES } from "./error-codes.js";

describe("ERROR_CODES", () => {
  it("are all namespace/slug (CONTRACTS §8)", () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(code, code).toMatch(ERROR_CODE_PATTERN);
    }
  });

  it("includes every code named in 07 §Conventions", () => {
    const codes = new Set<string>(Object.values(ERROR_CODES));
    for (const named of [
      "auth/expired",
      "credits/insufficient",
      "credits/needs_credits",
      "entitlement/upgrade_required",
      "edg/conflict",
      "edg/stale_op",
      "media/too_large",
      "export/unsupported_in_browser",
      "billing/mandate_cap_exceeded",
    ]) {
      expect(codes, named).toContain(named);
    }
  });

  it("has no duplicates", () => {
    const values = Object.values(ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("codeForStatus", () => {
  it("maps the statuses Nest raises on its own", () => {
    expect(codeForStatus(HttpStatus.BAD_REQUEST)).toBe(ERROR_CODES.badRequest);
    expect(codeForStatus(HttpStatus.UNAUTHORIZED)).toBe(ERROR_CODES.unauthorized);
    expect(codeForStatus(HttpStatus.FORBIDDEN)).toBe(ERROR_CODES.forbidden);
    expect(codeForStatus(HttpStatus.NOT_FOUND)).toBe(ERROR_CODES.notFound);
    expect(codeForStatus(HttpStatus.CONFLICT)).toBe(ERROR_CODES.conflict);
    expect(codeForStatus(HttpStatus.PAYLOAD_TOO_LARGE)).toBe(ERROR_CODES.payloadTooLarge);
    expect(codeForStatus(HttpStatus.UNSUPPORTED_MEDIA_TYPE)).toBe(ERROR_CODES.unsupportedMediaType);
    expect(codeForStatus(HttpStatus.TOO_MANY_REQUESTS)).toBe(ERROR_CODES.rateLimited);
    expect(codeForStatus(HttpStatus.SERVICE_UNAVAILABLE)).toBe(ERROR_CODES.unavailable);
  });

  it("falls back by class: 5xx internal, everything else bad request", () => {
    expect(codeForStatus(418)).toBe(ERROR_CODES.badRequest);
    expect(codeForStatus(502)).toBe(ERROR_CODES.internal);
  });
});

describe("AppException", () => {
  it("carries a code, a status and machine-readable details", () => {
    const error = new AppException(
      ERROR_CODES.entitlementUpgradeRequired,
      "Creator or above is required.",
      HttpStatus.PAYMENT_REQUIRED,
      { requiredPlan: "creator" },
    );

    expect(error.code).toBe("entitlement/upgrade_required");
    expect(error.httpStatus).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(error.details).toEqual({ requiredPlan: "creator" });
    // Still a real HttpException, so Nest's own machinery keeps working.
    expect(error.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(error.message).toBe("Creator or above is required.");
  });

  it("defaults to 400 with no details", () => {
    const error = new AppException(ERROR_CODES.badRequest, "Nope.");
    expect(error.httpStatus).toBe(HttpStatus.BAD_REQUEST);
    expect(error.details).toBeUndefined();
  });
});
