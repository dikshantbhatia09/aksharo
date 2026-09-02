import { beforeEach, describe, expect, it, vi } from "vitest";

import { CallbackClient } from "./callbacks.js";
import { transientFailure, unreadableMedia } from "./errors.js";
import { makeHandler } from "./runtime.js";

import type { Services } from "./runtime.js";
import type { Settings } from "./settings.js";
import type { Job } from "bullmq";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const MEDIA = "01JCMED1A00000000000000000";
const JOB = "01JCJ0B0000000000000000000";
const ATTEMPT = "01JCATTEMPT000000000000000";
const PREFIX = `ws/${WS}/p/${PROJECT}/media/${MEDIA}`;

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: JOB,
    attemptId: ATTEMPT,
    workspaceId: WS,
    projectId: PROJECT,
    priority: 3,
    jobKey: `media.probe:${MEDIA}`,
    createdAt: "2026-09-02T00:00:00.000Z",
    payload: { mediaId: MEDIA, key: `${PREFIX}/raw.mp4` },
    ...overrides,
  };
}

/** A BullMQ job, with only the fields the handler reads. */
function fakeJob(data: unknown, attemptsMade = 0, attempts = 3): Job {
  return {
    id: "bull-1",
    queueName: "media.probe",
    data,
    attemptsMade,
    opts: { attempts },
    updateProgress: vi.fn(async () => undefined),
  } as unknown as Job;
}

interface Recorded {
  readonly calls: { path: string; body: Record<string, unknown> }[];
  readonly services: Services;
}

function harness(): Recorded {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      path: new URL(String(url)).pathname,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ applied: true, jobId: JOB, status: "running" }), {
      status: 200,
    });
  });

  const callbacks = new CallbackClient("http://api.test", "s".repeat(40), {
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  });

  const settings = {
    queues: ["media.probe", "media.proxy"],
    concurrency: 1,
    queuePrefix: "test",
  } as unknown as Settings;

  return {
    calls,
    services: {
      settings,
      callbacks,
      raw: {} as Services["raw"],
      derived: {} as Services["derived"],
    },
  };
}

let h: Recorded;
beforeEach(() => {
  h = harness();
});

describe("makeHandler", () => {
  it("posts progress 0, then the media patch, then the completion", async () => {
    const handler = makeHandler(
      "media.probe",
      async (context) => {
        expect(context.derivedPrefix).toBe(PREFIX);
        return {
          result: { mediaId: MEDIA, durationMs: 10_000 },
          mediaPatch: { durationMs: 10_000 },
          usage: { mediaSeconds: 10 },
        };
      },
      h.services,
      new AbortController().signal,
    );

    const result = await handler(fakeJob(envelope()));
    expect(result).toEqual({ mediaId: MEDIA, durationMs: 10_000 });

    expect(h.calls.map((call) => call.path)).toEqual([
      `/internal/jobs/${JOB}/progress`,
      `/internal/media/${MEDIA}`,
      `/internal/jobs/${JOB}/complete`,
    ]);
    expect(h.calls[0]?.body).toMatchObject({ progress: 0 });
    expect(h.calls[1]?.body).toEqual({ durationMs: 10_000 });
    expect(h.calls[2]?.body).toMatchObject({
      status: "succeeded",
      usage: { mediaSeconds: 10 },
    });
  });

  it("refuses a job whose data is not the CONTRACTS §3 envelope, and posts nothing", async () => {
    // There is no jobId to complete against, and no retry will change the bytes.
    const handler = makeHandler(
      "media.probe",
      async () => ({ result: {} }),
      h.services,
      new AbortController().signal,
    );
    await expect(handler(fakeJob({ nope: true }))).rejects.toThrow(/CONTRACTS/);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses an envelope with a payload that is not a media payload", async () => {
    const handler = makeHandler(
      "media.probe",
      async () => ({ result: {} }),
      h.services,
      new AbortController().signal,
    );
    await expect(handler(fakeJob(envelope({ payload: { mediaId: MEDIA } })))).rejects.toThrow(
      /CONTRACTS/,
    );
    expect(h.calls).toHaveLength(0);
  });

  it("does NOT complete a retryable failure while attempts remain", async () => {
    // A failed completion on attempt one moves the row to `failed`, and attempt
    // two's completion is then rejected as `already_completed` — the retry would
    // be invisible to the product.
    const handler = makeHandler(
      "media.probe",
      async () => {
        throw transientFailure("media/store_unavailable", "the store said no");
      },
      h.services,
      new AbortController().signal,
    );
    await expect(handler(fakeJob(envelope(), 0, 3))).rejects.toThrow("the store said no");

    const paths = h.calls.map((call) => call.path);
    expect(paths).not.toContain(`/internal/jobs/${JOB}/complete`);
    expect(paths).not.toContain(`/internal/media/${MEDIA}`);
  });

  it("completes a retryable failure on the FINAL attempt, with finalAttempt", async () => {
    const handler = makeHandler(
      "media.probe",
      async () => {
        throw transientFailure("media/store_unavailable", "the store said no");
      },
      h.services,
      new AbortController().signal,
    );
    await expect(handler(fakeJob(envelope(), 2, 3))).rejects.toThrow("the store said no");

    const completion = h.calls.find((call) => call.path.endsWith("/complete"));
    expect(completion?.body).toMatchObject({
      status: "failed",
      finalAttempt: true,
      error: { code: "media/store_unavailable", retryable: true },
    });
  });

  it("completes a non-retryable failure immediately and marks the asset failed", async () => {
    const handler = makeHandler(
      "media.probe",
      async () => {
        throw unreadableMedia("no good", "media/corrupt", "moov atom not found");
      },
      h.services,
      new AbortController().signal,
    );
    await expect(handler(fakeJob(envelope(), 0, 3))).rejects.toThrow("no good");

    const patch = h.calls.find((call) => call.path === `/internal/media/${MEDIA}`);
    expect(patch?.body).toEqual({ status: "failed", failureReason: "media/corrupt" });

    const completion = h.calls.find((call) => call.path.endsWith("/complete"));
    expect(completion?.body).toMatchObject({
      status: "failed",
      error: { retryable: false, code: "media/unreadable" },
    });
    // The redacted ffmpeg tail rides on the message so an operator can see it.
    expect(String((completion?.body["error"] as Record<string, unknown>)["message"])).toContain(
      "moov atom not found",
    );
  });

  it("refuses a media job with no projectId, because no §6 key can be built", async () => {
    const handler = makeHandler(
      "media.probe",
      async () => ({ result: {} }),
      h.services,
      new AbortController().signal,
    );
    const withoutProject = envelope();
    delete withoutProject["projectId"];
    await expect(handler(fakeJob(withoutProject, 0, 3))).rejects.toThrow(/projectId/);

    const completion = h.calls.find((call) => call.path.endsWith("/complete"));
    // Terminal on the first attempt: retrying will not add a project to the job.
    expect(completion?.body).toMatchObject({ error: { retryable: false } });
  });

  it("survives a heartbeat the API refused, because the work is still fine", async () => {
    let first = true;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/progress") && first) {
        first = false;
        return new Response("nope", { status: 500 });
      }
      return new Response(JSON.stringify({ applied: true, jobId: JOB, status: "running" }), {
        status: 200,
      });
    });
    const services: Services = {
      ...h.services,
      callbacks: new CallbackClient("http://api.test", "s".repeat(40), {
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
        maxAttempts: 2,
        backoffMs: 1,
      }),
    };

    const handler = makeHandler(
      "media.probe",
      async (context) => {
        context.report(50);
        return { result: { ok: true } };
      },
      services,
      new AbortController().signal,
    );
    await expect(handler(fakeJob(envelope()))).resolves.toEqual({ ok: true });
  });
});
