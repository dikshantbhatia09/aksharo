import { describe, expect, it } from "vitest";

import { cookieExpiryFrom, resolveAttribution } from "./attribution.js";

const NOW = new Date("2026-09-02T00:00:00.000Z");

describe("resolveAttribution — precedence (brief §2)", () => {
  it("a code entered at sign-up beats an unexpired cookie", () => {
    const result = resolveAttribution({
      enteredCode: "CREATOR1",
      cookieCode: "OTHERAFF",
      cookieExpiresAt: new Date(NOW.getTime() + 1000),
      now: NOW,
    });
    expect(result).toEqual({ source: "code", code: "CREATOR1" });
  });

  it("falls back to an unexpired cookie when no code is entered", () => {
    const result = resolveAttribution({
      cookieCode: "creator1",
      cookieExpiresAt: new Date(NOW.getTime() + 1000),
      now: NOW,
    });
    expect(result).toEqual({
      source: "cookie",
      code: "CREATOR1",
      attributionExpiresAt: new Date(NOW.getTime() + 1000),
    });
  });

  it("ignores an expired cookie", () => {
    const result = resolveAttribution({
      cookieCode: "creator1",
      cookieExpiresAt: new Date(NOW.getTime() - 1000),
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it("returns null when neither a code nor an unexpired cookie is present", () => {
    expect(resolveAttribution({ now: NOW })).toBeNull();
  });

  it("ignores a blank entered code and falls back to the cookie", () => {
    const result = resolveAttribution({
      enteredCode: "   ",
      cookieCode: "creator1",
      cookieExpiresAt: new Date(NOW.getTime() + 1000),
      now: NOW,
    });
    expect(result?.source).toBe("cookie");
  });
});

describe("cookieExpiryFrom", () => {
  it("is exactly 60 days after the click", () => {
    const clickedAt = new Date("2026-01-01T00:00:00.000Z");
    const expiry = cookieExpiryFrom(clickedAt);
    expect(expiry.getTime() - clickedAt.getTime()).toBe(60 * 24 * 60 * 60 * 1000);
  });
});
