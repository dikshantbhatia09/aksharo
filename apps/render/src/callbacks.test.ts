/**
 * The signed callback client. Its Python twin is
 * `apps/worker-ai/worker_ai/callbacks.py`, and the important assertions here are
 * the ones that would let the two drift: the header names, the signed string,
 * and the fact that the bytes signed are the bytes sent.
 */

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ATTEMPT_HEADER,
  CallbackClient,
  CallbackError,
  encodeCompletion,
  encodeUsage,
  SIGNATURE_HEADER,
  SIGNATURE_SKEW_MS,
  signatureHeaders,
  signRequest,
  TIMESTAMP_HEADER,
  type FetchLike,
} from "./callbacks.js";

const SECRET = "callback-secret";

interface Call {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function recorder(responses: { status: number; body?: string }[]): {
  calls: Call[];
  fetch: FetchLike;
} {
  const calls: Call[] = [];
  let index = 0;
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (response === undefined) throw new Error("no response configured");
    return Promise.resolve({
      status: response.status,
      text: () => Promise.resolve(response.body ?? "{}"),
    });
  };
  return { calls, fetch };
}

function client(fetch: FetchLike, overrides: Record<string, unknown> = {}): CallbackClient {
  return new CallbackClient({
    apiOrigin: "http://api.test/",
    secret: SECRET,
    fetch,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...overrides,
  });
}

describe("the signature", () => {
  it("is hmac_sha256 over the timestamp, a dot and the body, as CONTRACTS section 3 says", () => {
    const body = '{"progress":50}';
    const expected = createHmac("sha256", SECRET).update(`1700000000.${body}`).digest("hex");
    expect(signRequest(SECRET, 1_700_000_000, body)).toBe(expected);
    expect(signRequest(SECRET, "1700000000", body)).toBe(expected);
  });

  it("uses the header names the API's guard reads", () => {
    expect(ATTEMPT_HEADER).toBe("x-montaj-attempt");
    expect(TIMESTAMP_HEADER).toBe("x-montaj-timestamp");
    expect(SIGNATURE_HEADER).toBe("x-montaj-signature");
  });

  it("writes the timestamp in seconds, not milliseconds", () => {
    const headers = signatureHeaders({
      secret: SECRET,
      attemptId: "a",
      body: "{}",
      now: 1_700_000_000_123,
    });
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    expect(headers[TIMESTAMP_HEADER]).toBe("1700000000");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("agrees with the API's five-minute window", () => {
    expect(SIGNATURE_SKEW_MS).toBe(300_000);
  });
});

describe("the wire bodies", () => {
  it("omits every unset usage field and rounds the floats", () => {
    expect(encodeUsage({ outputSeconds: 10.123456, egressBytes: 0 })).toEqual({
      outputSeconds: 10.123,
      egressBytes: 0,
    });
    expect(encodeUsage({})).toEqual({});
  });

  it("truncates the integer usage fields", () => {
    expect(encodeUsage({ costMinor: 12.9, actualTenths: 5.7, mediaSeconds: 1 })).toEqual({
      costMinor: 12,
      actualTenths: 5,
      mediaSeconds: 1,
    });
  });

  it("clips an over-long error and never sends an empty message", () => {
    const wire = encodeCompletion({
      status: "failed",
      error: { code: "x".repeat(200), message: "", retryable: false },
    });
    const error = wire["error"] as { code: string; message: string };
    expect(error.code).toHaveLength(128);
    expect(error.message).toBe("failed");
  });

  it("drops an empty usage object rather than sending `usage: {}`", () => {
    expect(encodeCompletion({ status: "succeeded", usage: {} })).toEqual({ status: "succeeded" });
  });

  it("carries finalAttempt when it is set", () => {
    expect(encodeCompletion({ status: "failed", finalAttempt: true })["finalAttempt"]).toBe(true);
  });
});

describe("the client", () => {
  it("signs the exact bytes it sends", async () => {
    const { calls, fetch } = recorder([{ status: 200, body: '{"applied":true,"jobId":"j"}' }]);
    await client(fetch).progress("j", "a", 42.129, { etaMs: 1_234.9, message: "half way" });

    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.url).toBe("http://api.test/internal/jobs/j/progress");
    expect(JSON.parse(call.body)).toEqual({ progress: 42.13, etaMs: 1_234, message: "half way" });
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const timestamp = call.headers[TIMESTAMP_HEADER];
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    expect(call.headers[SIGNATURE_HEADER]).toBe(signRequest(SECRET, timestamp ?? "", call.body));
  });

  it("clamps progress into 0–100", async () => {
    const { calls, fetch } = recorder([{ status: 200 }]);
    const callbacks = client(fetch);
    await callbacks.progress("j", "a", 250);
    await callbacks.progress("j", "a", -5);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ progress: 100 });
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ progress: 0 });
  });

  it("reports a replay as applied: false rather than as a failure", async () => {
    const { fetch } = recorder([
      {
        status: 200,
        body: '{"applied":false,"jobId":"j","status":"succeeded","reason":"already_completed"}',
      },
    ]);
    const ack = await client(fetch).complete("j", "a", { status: "succeeded" });
    expect(ack).toEqual({
      applied: false,
      jobId: "j",
      status: "succeeded",
      reason: "already_completed",
    });
  });

  it("tolerates an ack that is not JSON", async () => {
    const { fetch } = recorder([{ status: 200, body: "not json" }]);
    const ack = await client(fetch).complete("j", "a", { status: "succeeded" });
    expect(ack.applied).toBe(true);
  });

  it("retries a 5xx and re-signs each attempt", async () => {
    const { calls, fetch } = recorder([
      { status: 503 },
      { status: 503 },
      { status: 200, body: '{"applied":true}' },
    ]);
    await client(fetch).complete("j", "a", { status: "succeeded" });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      expect(call.headers[SIGNATURE_HEADER]).toBe(
        // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
        signRequest(SECRET, call.headers[TIMESTAMP_HEADER] ?? "", call.body),
      );
    }
  });

  it("retries a 429 too", async () => {
    const { calls, fetch } = recorder([{ status: 429 }, { status: 200 }]);
    await client(fetch).complete("j", "a", { status: "succeeded" });
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 4xx, which is a contract error", async () => {
    const { calls, fetch } = recorder([{ status: 401 }]);
    await expect(client(fetch).complete("j", "a", { status: "succeeded" })).rejects.toThrow(
      CallbackError,
    );
    expect(calls).toHaveLength(1);
  });

  it("gives up after the attempt budget and says how many it tried", async () => {
    const { calls, fetch } = recorder([{ status: 500 }]);
    await expect(
      client(fetch, { maxAttempts: 3 }).complete("j", "a", { status: "succeeded" }),
    ).rejects.toThrow(/failed after 3 attempts/);
    expect(calls).toHaveLength(3);
  });

  it("retries a transport failure", async () => {
    let attempt = 0;
    const fetch: FetchLike = () => {
      attempt += 1;
      if (attempt < 2) return Promise.reject(new Error("ECONNRESET"));
      return Promise.resolve({ status: 200, text: () => Promise.resolve("{}") });
    };
    await client(fetch).complete("j", "a", { status: "succeeded" });
    expect(attempt).toBe(2);
  });

  it("refuses to exist without a secret to sign with", () => {
    expect(() => new CallbackClient({ apiOrigin: "http://api.test", secret: "" })).toThrow(
      /INTERNAL_CALLBACK_SECRET/,
    );
  });

  it("strips trailing slashes from the origin", async () => {
    const { calls, fetch } = recorder([{ status: 200 }]);
    await client(fetch, { apiOrigin: "http://api.test///" }).progress("j", "a", 1);
    expect(calls[0]?.url).toBe("http://api.test/internal/jobs/j/progress");
  });
});
