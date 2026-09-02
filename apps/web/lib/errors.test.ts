import { describe, expect, it } from "vitest";

import { ApiError } from "@montaj/api-client";

import { fieldErrors, messageForError, retryAfterSeconds } from "./errors";

function apiError(code: string, message = "raw", extra: Record<string, unknown> = {}): ApiError {
  return new ApiError({ code, message, status: 400, ...extra });
}

describe("messageForError", () => {
  it("says what to do next, not what the code was (08 §6)", () => {
    expect(messageForError(apiError("auth/invalid_credentials"))).toMatch(/sign-in link/i);
    expect(messageForError(apiError("credits/insufficient"))).toMatch(/top up/i);
    expect(messageForError(apiError("common/rate_limited"))).toMatch(/wait a moment/i);
  });

  it("never leaks that an address exists", () => {
    // A04 answers 202 for every sign-up; nothing in the copy may contradict it.
    for (const message of Object.values({
      invalid: messageForError(apiError("auth/invalid_credentials")),
      token: messageForError(apiError("auth/invalid_token")),
    })) {
      expect(message.toLowerCase()).not.toContain("already");
      expect(message.toLowerCase()).not.toContain("taken");
      expect(message.toLowerCase()).not.toContain("no account");
    }
  });

  it("falls back to the API's own message for an unmapped code", () => {
    expect(
      messageForError(apiError("billing/mandate_cap_exceeded", "Your mandate cap is ₹5,000.")),
    ).toBe("Your mandate cap is ₹5,000.");
  });

  it("handles a plain Error and an unknown value", () => {
    expect(messageForError(new Error("boom"))).toBe("boom");
    expect(messageForError("nope")).toBe("Something went wrong. Try again.");
    expect(messageForError(new Error(""))).toBe("Something went wrong. Try again.");
  });
});

describe("retryAfterSeconds", () => {
  it("rounds a Retry-After up to whole seconds", () => {
    expect(retryAfterSeconds(apiError("common/rate_limited", "slow", { retryAfterMs: 1500 }))).toBe(
      2,
    );
  });

  it("is undefined without one", () => {
    expect(retryAfterSeconds(apiError("common/rate_limited"))).toBeUndefined();
    expect(retryAfterSeconds(new Error("x"))).toBeUndefined();
  });
});

describe("fieldErrors", () => {
  it("maps a validation envelope onto form fields", () => {
    const error = apiError("common/validation_failed", "bad", {
      details: {
        issues: [
          { path: ["email"], message: "Invalid email" },
          { path: ["consents", "analytics"], message: "Must be a boolean" },
        ],
      },
    });
    expect(fieldErrors(error)).toEqual({
      email: "Invalid email",
      "consents.analytics": "Must be a boolean",
    });
  });

  it("is empty for anything else", () => {
    expect(fieldErrors(apiError("auth/expired"))).toEqual({});
    expect(fieldErrors(apiError("common/validation_failed", "bad", { details: {} }))).toEqual({});
    expect(fieldErrors(new Error("x"))).toEqual({});
  });
});
