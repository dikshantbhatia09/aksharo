import { describe, expect, it } from "vitest";

import {
  bearerMatches,
  extractBearer,
  isAllowedHost,
  isAllowedOrigin,
  RateLimiter,
} from "./security.js";

describe("bearerMatches", () => {
  it("matches identical tokens", () => {
    expect(bearerMatches("abc123", "abc123")).toBe(true);
  });
  it("rejects a wrong token of the same length", () => {
    expect(bearerMatches("abc124", "abc123")).toBe(false);
  });
  it("rejects a different-length token", () => {
    expect(bearerMatches("abc", "abc123")).toBe(false);
  });
  it("rejects undefined/empty", () => {
    expect(bearerMatches(undefined, "abc123")).toBe(false);
    expect(bearerMatches("", "abc123")).toBe(false);
  });
});

describe("extractBearer", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearer("Bearer sometoken")).toBe("sometoken");
  });
  it("returns undefined for a malformed header", () => {
    expect(extractBearer("Basic sometoken")).toBeUndefined();
    expect(extractBearer(undefined)).toBeUndefined();
  });
});

describe("isAllowedHost", () => {
  it("accepts 127.0.0.1:<port> and localhost:<port>", () => {
    expect(isAllowedHost("127.0.0.1:47831", 47831)).toBe(true);
    expect(isAllowedHost("localhost:47831", 47831)).toBe(true);
  });
  it("rejects any other host, including a matching port on a DNS name", () => {
    expect(isAllowedHost("evil.example.com:47831", 47831)).toBe(false);
    expect(isAllowedHost("127.0.0.1:9999", 47831)).toBe(false);
    expect(isAllowedHost(undefined, 47831)).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  it("accepts the hosted web app and plugin origins", () => {
    expect(isAllowedOrigin("https://app.aksharo.ai")).toBe(true);
    expect(isAllowedOrigin("https://ai.aksharo.panel")).toBe(true);
  });
  it("rejects null, empty, and unlisted origins", () => {
    expect(isAllowedOrigin("null")).toBe(false);
    expect(isAllowedOrigin("")).toBe(false);
    expect(isAllowedOrigin(undefined)).toBe(false);
    expect(isAllowedOrigin("https://evil.example.com")).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("allows up to max within the window and then rejects", () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 2 });
    const now = 1_000_000;
    expect(limiter.consume("k", now)).toBe(true);
    expect(limiter.consume("k", now)).toBe(true);
    expect(limiter.consume("k", now)).toBe(false);
  });
  it("resets after the window passes", () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 1 });
    const now = 1_000_000;
    expect(limiter.consume("k", now)).toBe(true);
    expect(limiter.consume("k", now + 1001)).toBe(true);
  });
  it("tracks keys independently", () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 1 });
    const now = 1_000_000;
    expect(limiter.consume("a", now)).toBe(true);
    expect(limiter.consume("b", now)).toBe(true);
  });
});
