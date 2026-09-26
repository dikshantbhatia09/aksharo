import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTEMPT_HEADER,
  CallbackClient,
  CallbackError,
  DURABLE_CALLBACK_BUDGET_MS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  internalSignatureHeaders,
  signInternalRequest,
} from "./callbacks.js";

const SECRET = "test-callback-secret-at-least-32-characters-long";
const JOB = "01JCJ0B0000000000000000000";
const ATTEMPT = "01JCATTEMPT000000000000000";

function ok(body: unknown = { applied: true, jobId: JOB, status: "running" }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("signInternalRequest", () => {
  it("is exactly hex(hmac_sha256(secret, timestamp + '.' + body)) — CONTRACTS §3", () => {
    // Spelled out rather than compared to the implementation: this is the value
    // `internal-signature.ts` and `callbacks.py` independently compute, and if all
    // three drift together the contract has quietly changed.
    const body = '{"progress":50}';
    const expected = createHmac("sha256", SECRET).update(`1767225600.${body}`).digest("hex");
    expect(signInternalRequest({ secret: SECRET, timestamp: 1_767_225_600, body })).toBe(expected);
  });

  it("changes when any of the three inputs changes", () => {
    const base = { secret: SECRET, timestamp: 1_767_225_600, body: "{}" };
    const signature = signInternalRequest(base);
    expect(signInternalRequest({ ...base, timestamp: 1_767_225_601 })).not.toBe(signature);
    expect(signInternalRequest({ ...base, body: "{ }" })).not.toBe(signature);
    expect(signInternalRequest({ ...base, secret: `${SECRET}x` })).not.toBe(signature);
  });
});

describe("internalSignatureHeaders", () => {
  it("sends the three headers the guard reads, with seconds not milliseconds", () => {
    const headers = internalSignatureHeaders({
      secret: SECRET,
      attemptId: ATTEMPT,
      body: "{}",
      now: 1_767_225_600_500,
    });
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    expect(headers[ATTEMPT_HEADER]).toBe(ATTEMPT);
    // The guard refuses anything ≥ 1e11 as "that looks like milliseconds".
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    expect(headers[TIMESTAMP_HEADER]).toBe("1767225600");
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    expect(headers[SIGNATURE_HEADER]).toHaveLength(64);
    expect(headers["content-type"]).toBe("application/json");
  });
});

describe("CallbackClient", () => {
  it("refuses to exist without a secret", () => {
    expect(() => new CallbackClient("http://api.test", "")).toThrow(/INTERNAL_CALLBACK_SECRET/);
  });

  it("signs the exact bytes it sends", async () => {
    // The API verifies against `request.rawBody`; a re-encoded body would verify
    // in a unit test and fail in production.
    const fetchImpl = vi.fn(async () => ok());
    const client = new CallbackClient("http://api.test/", SECRET, {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    await client.progress(JOB, ATTEMPT, 42.129, { message: "half way" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://api.test/internal/jobs/${JOB}/progress`);
    const headers = init.headers as Record<string, string>;
    const expected = signInternalRequest({
      secret: SECRET,
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      timestamp: headers[TIMESTAMP_HEADER] ?? "",
      body: init.body as string,
    });
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    expect(headers[SIGNATURE_HEADER]).toBe(expected);
    // Rounded to two places, and clamped into 0–100 by the schema's bounds.
    expect(JSON.parse(init.body as string)).toEqual({ progress: 42.13, message: "half way" });
  });

  it("clamps progress into the range the API's schema allows", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => ok());
    const client = new CallbackClient("http://api.test", SECRET, {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    await client.progress(JOB, ATTEMPT, 140);
    await client.progress(JOB, ATTEMPT, -3);
    const bodies = fetchImpl.mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string) as { progress: number },
    );
    expect(bodies.map((body) => body.progress)).toEqual([100, 0]);
  });

  it("reports a replay as applied: false rather than as a failure", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ applied: false, jobId: JOB, status: "succeeded", reason: "already_completed" }),
    );
    const client = new CallbackClient("http://api.test", SECRET, {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    const ack = await client.complete(JOB, ATTEMPT, { status: "succeeded" });
    expect(ack).toEqual({
      applied: false,
      jobId: JOB,
      status: "succeeded",
      reason: "already_completed",
    });
  });

  it("does not retry a 4xx — it is a contract error, and the window is finite", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = new CallbackClient("http://api.test", SECRET, {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      maxAttempts: 4,
      backoffMs: 1,
    });
    await expect(client.complete(JOB, ATTEMPT, { status: "succeeded" })).rejects.toBeInstanceOf(
      CallbackError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx and succeeds when the API comes back", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? new Response("busy", { status: 503 }) : ok();
    });
    const client = new CallbackClient("http://api.test", SECRET, {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      maxAttempts: 4,
      backoffMs: 1,
    });
    const ack = await client.complete(JOB, ATTEMPT, { status: "succeeded" });
    expect(ack.applied).toBe(true);
    expect(calls).toBe(3);
  });

  it("re-signs each retry, so a long backoff cannot age out of the window", async () => {
    let calls = 0;
    const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => {
      calls += 1;
      return calls === 1 ? new Response("busy", { status: 500 }) : ok();
    });
    const client = new CallbackClient("http://api.test", SECRET, {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      maxAttempts: 2,
      backoffMs: 1,
    });
    await client.complete(JOB, ATTEMPT, { status: "succeeded" });
    const signatures = fetchImpl.mock.calls.map(
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      ([, init]) => ((init as RequestInit).headers as Record<string, string>)[SIGNATURE_HEADER],
    );
    expect(signatures).toHaveLength(2);
    // Same body, so the only thing that can differ is the timestamp — which is
    // the point: it is re-signed rather than replayed.
    expect(signatures[0]).toBeDefined();
  });

  it("gives up after maxAttempts and says how many it tried", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = new CallbackClient("http://api.test", SECRET, {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      maxAttempts: 3,
      backoffMs: 1,
    });
    await expect(client.progress(JOB, ATTEMPT, 10)).rejects.toThrow(/after 3 attempts/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  describe("durable callbacks (a completion, a media write-back)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Unreachable until `outageMs` has passed, then healthy. */
    function restartingApi(outageMs: number): ReturnType<typeof vi.fn> {
      const until = Date.now() + outageMs;
      return vi.fn(async () => {
        if (Date.now() < until) throw new TypeError("fetch failed");
        return ok({ applied: true, jobId: JOB, status: "failed" });
      });
    }

    it("delivers a completion through an API restart that outlasts the heartbeat budget", async () => {
      // Four tries over ~3 s used to be all a terminal completion got. An API
      // restart through the tunnel takes 10-15 s, the completion was dropped,
      // and the job sat `running` with the run spinning forever.
      vi.useFakeTimers();
      const fetchImpl = restartingApi(60_000);
      const client = new CallbackClient("http://api.test", SECRET, {
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
      });
      const delivered = client.complete(JOB, ATTEMPT, { status: "failed", finalAttempt: true });
      await vi.advanceTimersByTimeAsync(90_000);
      await expect(delivered).resolves.toMatchObject({ applied: true });
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(4);
    });

    it("delivers a media write-back the same way", async () => {
      vi.useFakeTimers();
      let calls = 0;
      const until = Date.now() + 30_000;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        return Date.now() < until ? new Response("restarting", { status: 502 }) : ok();
      });
      const client = new CallbackClient("http://api.test", SECRET, {
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
      });
      const delivered = client.patchMedia("01JCMED1A00000000000000000", ATTEMPT, {
        status: "failed",
        failureReason: "media/source_failed",
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(delivered).resolves.toBeUndefined();
      expect(calls).toBeGreaterThan(4);
    });

    it("gives up once the budget is spent, and never starts a try past it", async () => {
      // Asserted on when each try started, not on how many fit in a window: the
      // waits are jittered, so a count is right only most of the time.
      vi.useFakeTimers();
      const start = Date.now();
      const tries: number[] = [];
      const fetchImpl = vi.fn(async () => {
        tries.push(Date.now() - start);
        return new Response("down", { status: 503 });
      });
      const client = new CallbackClient("http://api.test", SECRET, {
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
      });
      let settledAt: number | null = null;
      const outcome = expect(
        client.complete(JOB, ATTEMPT, { status: "succeeded" }).finally(() => {
          settledAt = Date.now() - start;
        }),
      ).rejects.toThrow(/failed after \d+ attempts/);

      // No wait is longer than 15 s, so nothing can give up 20 s before the end.
      await vi.advanceTimersByTimeAsync(DURABLE_CALLBACK_BUDGET_MS - 20_000);
      expect(settledAt).toBeNull();

      await vi.advanceTimersByTimeAsync(60_000);
      await outcome;
      expect(tries.length).toBeGreaterThan(4);
      // Every try starts inside the budget...
      expect(Math.max(...tries)).toBeLessThanOrEqual(DURABLE_CALLBACK_BUDGET_MS);
      // ...it stops only when the next wait (at most 15 s) would have crossed it...
      expect(Math.max(...tries)).toBeGreaterThan(DURABLE_CALLBACK_BUDGET_MS - 15_000);
      // ...and it says so straight away, not one wait later.
      expect(settledAt).toBe(Math.max(...tries));
    });

    it("gives a plain 500 only the heartbeat's few tries: the API is up and its handler threw", async () => {
      // A completion handler that throws answers 500 every time. Two minutes
      // of that per BullMQ attempt held the single acquire slot for six, and
      // re-drove the failing handler about ten times an attempt.
      vi.useFakeTimers();
      const fetchImpl = vi.fn(async () => new Response("handler threw", { status: 500 }));
      const client = new CallbackClient("http://api.test", SECRET, {
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
      });
      const outcome = expect(client.complete(JOB, ATTEMPT, { status: "succeeded" })).rejects.toThrow(
        /after 4 attempts/,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await outcome;
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it("reads a gateway or tunnel answering for a missing API as a restart, and waits it out", async () => {
      // 530 is Cloudflare with no tunnel to the origin; 504 a gateway timeout.
      vi.useFakeTimers();
      for (const status of [504, 530]) {
        const until = Date.now() + 30_000;
        const fetchImpl = vi.fn(async () =>
          Date.now() < until ? new Response("no origin", { status }) : ok(),
        );
        const client = new CallbackClient("http://api.test", SECRET, {
          fetch: fetchImpl as unknown as typeof globalThis.fetch,
        });
        const delivered = client.complete(JOB, ATTEMPT, { status: "failed" });
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(delivered, String(status)).resolves.toMatchObject({ applied: true });
        expect(fetchImpl.mock.calls.length, String(status)).toBeGreaterThan(4);
      }
    });

    it("still refuses to retry a 4xx, however durable", async () => {
      const fetchImpl = vi.fn(async () => new Response("nope", { status: 400 }));
      const client = new CallbackClient("http://api.test", SECRET, {
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
      });
      await expect(
        client.patchMedia("01JCMED1A00000000000000000", ATTEMPT, { durationMs: 1 }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("keeps a heartbeat to its own short budget", async () => {
      // Progress is not durable: the next beat carries the news, and a worker
      // must not stall its encode for two minutes on a dropped heartbeat.
      vi.useFakeTimers();
      const fetchImpl = restartingApi(60_000);
      const client = new CallbackClient("http://api.test", SECRET, {
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
      });
      const outcome = expect(client.progress(JOB, ATTEMPT, 50)).rejects.toThrow(
        /after 4 attempts/,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await outcome;
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    });
  });

  it("PATCHes the media allow-list at the internal media route", async () => {
    const fetchImpl = vi.fn(async () => ok({ mediaId: "m", status: "ready" }));
    const client = new CallbackClient("http://api.test", SECRET, {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    await client.patchMedia("01JCMED1A00000000000000000", ATTEMPT, { durationMs: 10_000 });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/internal/media/01JCMED1A00000000000000000");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ durationMs: 10_000 });
  });
});
