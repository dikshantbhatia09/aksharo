import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ATTEMPT_HEADER,
  SIGNATURE_HEADER,
  SIGNATURE_SKEW_MS,
  TIMESTAMP_HEADER,
  internalSignatureHeaders,
  signInternalRequest,
  verifyInternalSignature,
} from "./internal-signature.js";

const SECRET = "test-callback-secret-at-least-32-characters-long";
const BODY = JSON.stringify({ status: "succeeded", usage: { mediaSeconds: 12.5 } });
const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const TIMESTAMP = Math.floor(NOW / 1000);

function ok(overrides: Record<string, unknown> = {}) {
  return verifyInternalSignature({
    secret: SECRET,
    attempt: "01JCATTEMPT0000000000000000".slice(0, 26),
    timestamp: String(TIMESTAMP),
    signature: signInternalRequest({ secret: SECRET, timestamp: TIMESTAMP, body: BODY }),
    body: Buffer.from(BODY, "utf8"),
    now: NOW,
    ...overrides,
  });
}

describe("signInternalRequest (CONTRACTS §3)", () => {
  it("is hex(hmac_sha256(secret, timestamp + '.' + body))", () => {
    const expected = createHmac("sha256", SECRET)
      .update(`${String(TIMESTAMP)}.${BODY}`)
      .digest("hex");
    expect(signInternalRequest({ secret: SECRET, timestamp: TIMESTAMP, body: BODY })).toBe(
      expected,
    );
  });

  it("signs raw bytes, so a Buffer and its string are the same signature", () => {
    expect(signInternalRequest({ secret: SECRET, timestamp: TIMESTAMP, body: BODY })).toBe(
      signInternalRequest({ secret: SECRET, timestamp: TIMESTAMP, body: Buffer.from(BODY) }),
    );
  });

  it("changes with the body, the timestamp and the secret", () => {
    const base = signInternalRequest({ secret: SECRET, timestamp: TIMESTAMP, body: BODY });
    expect(
      signInternalRequest({ secret: SECRET, timestamp: TIMESTAMP, body: `${BODY} ` }),
    ).not.toBe(base);
    expect(signInternalRequest({ secret: SECRET, timestamp: TIMESTAMP + 1, body: BODY })).not.toBe(
      base,
    );
    expect(
      signInternalRequest({ secret: `${SECRET}x`, timestamp: TIMESTAMP, body: BODY }),
    ).not.toBe(base);
  });

  it("cannot be forged by moving a character across the separator", () => {
    // `timestamp + "." + body` rather than a plain concatenation is what stops
    // (ts="12", body="3…") and (ts="123", body="…") producing the same digest.
    const a = signInternalRequest({ secret: SECRET, timestamp: "12", body: "3.x" });
    const b = signInternalRequest({ secret: SECRET, timestamp: "123", body: "x" });
    expect(a).not.toBe(b);
  });
});

describe("internalSignatureHeaders", () => {
  it("produces the three contract headers", () => {
    const headers = internalSignatureHeaders({
      secret: SECRET,
      attemptId: "01JCATTEMPT0000000000000000".slice(0, 26),
      body: BODY,
      now: NOW,
    });
    expect(headers[ATTEMPT_HEADER]).toHaveLength(26);
    expect(headers[TIMESTAMP_HEADER]).toBe(String(TIMESTAMP));
    expect(headers[SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["content-type"]).toBe("application/json");
  });

  it("round-trips through verify", () => {
    const headers = internalSignatureHeaders({
      secret: SECRET,
      attemptId: "01JCATTEMPT0000000000000000".slice(0, 26),
      body: BODY,
      now: NOW,
    });
    expect(
      verifyInternalSignature({
        secret: SECRET,
        attempt: headers[ATTEMPT_HEADER],
        timestamp: headers[TIMESTAMP_HEADER],
        signature: headers[SIGNATURE_HEADER],
        body: Buffer.from(BODY, "utf8"),
        now: NOW,
      }),
    ).toEqual({ ok: true, attemptId: "01JCATTEMPT0000000000000000".slice(0, 26), key: "primary" });
  });
});

describe("verifyInternalSignature (THREAT-MODEL T8)", () => {
  it("accepts a correctly signed request", () => {
    expect(ok()).toMatchObject({ ok: true });
  });

  it("requires all three headers and the raw body", () => {
    expect(ok({ attempt: undefined })).toEqual({ ok: false, failure: "missing_attempt" });
    expect(ok({ timestamp: undefined })).toEqual({ ok: false, failure: "missing_timestamp" });
    expect(ok({ signature: undefined })).toEqual({ ok: false, failure: "missing_signature" });
    expect(ok({ body: undefined })).toEqual({ ok: false, failure: "missing_body" });
  });

  it("rejects a repeated header, which arrives as an array", () => {
    expect(ok({ signature: ["a", "b"] })).toEqual({ ok: false, failure: "missing_signature" });
  });

  it("rejects a tampered body", () => {
    expect(ok({ body: Buffer.from(`${BODY} `, "utf8") })).toEqual({
      ok: false,
      failure: "signature_mismatch",
    });
  });

  it("rejects a signature of the right shape but the wrong value", () => {
    expect(ok({ signature: "0".repeat(64) })).toEqual({
      ok: false,
      failure: "signature_mismatch",
    });
  });

  it("rejects a signature signed with another secret", () => {
    expect(
      ok({
        signature: signInternalRequest({
          secret: "another-secret",
          timestamp: TIMESTAMP,
          body: BODY,
        }),
      }),
    ).toEqual({ ok: false, failure: "signature_mismatch" });
  });

  it("accepts a timestamp inside the five-minute window, either side", () => {
    expect(ok({ now: NOW + SIGNATURE_SKEW_MS })).toMatchObject({ ok: true });
    expect(ok({ now: NOW - SIGNATURE_SKEW_MS })).toMatchObject({ ok: true });
  });

  it("rejects a replay outside the window", () => {
    expect(ok({ now: NOW + SIGNATURE_SKEW_MS + 1 })).toEqual({
      ok: false,
      failure: "timestamp_skew",
    });
    expect(ok({ now: NOW - SIGNATURE_SKEW_MS - 1 })).toEqual({
      ok: false,
      failure: "timestamp_skew",
    });
  });

  it("rejects a non-numeric timestamp", () => {
    expect(ok({ timestamp: "not-a-number" })).toEqual({
      ok: false,
      failure: "malformed_timestamp",
    });
    expect(ok({ timestamp: "-1" })).toEqual({ ok: false, failure: "malformed_timestamp" });
  });

  it("rejects milliseconds, which is the easy mistake to make", () => {
    expect(ok({ timestamp: String(NOW) })).toEqual({ ok: false, failure: "malformed_timestamp" });
  });

  it("checks the window before the HMAC, so a stale replay is cheap", () => {
    expect(ok({ now: NOW + SIGNATURE_SKEW_MS + 1, signature: "0".repeat(64) })).toEqual({
      ok: false,
      failure: "timestamp_skew",
    });
  });
});

describe("two-key rotation (INTERNAL_CALLBACK_SECRET_NEXT)", () => {
  const NEXT = "the-incoming-callback-secret-at-least-32-chars";
  const signedWithNext = signInternalRequest({ secret: NEXT, timestamp: TIMESTAMP, body: BODY });

  it("accepts the primary secret while a rotation is in progress", () => {
    expect(ok({ secretNext: NEXT })).toEqual({
      ok: true,
      attemptId: "01JCATTEMPT0000000000000000".slice(0, 26),
      key: "primary",
    });
  });

  it("accepts the NEXT secret when it is set", () => {
    expect(ok({ secretNext: NEXT, signature: signedWithNext })).toEqual({
      ok: true,
      attemptId: "01JCATTEMPT0000000000000000".slice(0, 26),
      key: "next",
    });
  });

  it("rejects the NEXT secret when it is not set", () => {
    expect(ok({ signature: signedWithNext })).toEqual({ ok: false, failure: "signature_mismatch" });
    expect(ok({ secretNext: undefined, signature: signedWithNext })).toEqual({
      ok: false,
      failure: "signature_mismatch",
    });
    expect(ok({ secretNext: "", signature: signedWithNext })).toEqual({
      ok: false,
      failure: "signature_mismatch",
    });
  });

  it("rejects a third secret even when both keys are configured", () => {
    expect(
      ok({
        secretNext: NEXT,
        signature: signInternalRequest({
          secret: "a-third-secret-that-nobody-configured-here",
          timestamp: TIMESTAMP,
          body: BODY,
        }),
      }),
    ).toEqual({ ok: false, failure: "signature_mismatch" });
  });

  it("leaves the skew rule alone: a valid NEXT signature outside the window still fails", () => {
    expect(
      ok({ secretNext: NEXT, signature: signedWithNext, now: NOW + SIGNATURE_SKEW_MS + 1 }),
    ).toEqual({ ok: false, failure: "timestamp_skew" });
  });
});
