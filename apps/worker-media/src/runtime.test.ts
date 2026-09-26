import { UnrecoverableError } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CallbackClient } from "./callbacks.js";
import { MediaJobError, sourceRefused, transientFailure, unreadableMedia } from "./errors.js";
import { Heartbeat, MIN_PROGRESS_POST_MS, makeHandler } from "./runtime.js";

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

/** A BullMQ job, with only the fields the handler reads — and writes, like Redis would. */
function fakeJob(data: unknown, attemptsMade = 0, attempts = 3, queueName = "media.probe"): Job {
  const job = {
    id: "bull-1",
    queueName,
    data,
    attemptsMade,
    opts: { attempts },
    updateProgress: vi.fn(async () => undefined),
    updateData: vi.fn(async (next: unknown) => {
      job.data = next;
    }),
  };
  return job as unknown as Job;
}

interface Recorded {
  readonly calls: { path: string; body: Record<string, unknown> }[];
  readonly services: Services;
}

/** `status` decides the API's answer to each call; 200 unless it says otherwise. */
function harness(
  status: (path: string, body: Record<string, unknown>) => number = () => 200,
): Recorded {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body });
    return new Response(JSON.stringify({ applied: true, jobId: JOB, status: "running" }), {
      status: status(path, body),
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

describe("makeHandler and BullMQ's own retries", () => {
  it("throws UnrecoverableError for a non-retryable failure, so BullMQ runs it once", async () => {
    // BullMQ does not read `retryable`. Rethrowing the MediaJobError itself
    // downloaded a video over the plan's cap three times (job
    // 01M3CB39D6YD4GJ0EQT83MPGR3), the last two completions refused.
    const failure = unreadableMedia("no good", "media/corrupt");
    const handler = makeHandler(
      "media.probe",
      async () => {
        throw failure;
      },
      h.services,
      new AbortController().signal,
    );
    const thrown = await handler(fakeJob(envelope(), 0, 3)).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect((thrown as Error).message).toBe("no good");
    expect((thrown as Error).cause).toBe(failure);

    // Reported exactly once, as terminal, although attempts remain.
    const completions = h.calls.filter((call) => call.path.endsWith("/complete"));
    expect(completions).toHaveLength(1);
    expect(completions[0]?.body).toMatchObject({
      status: "failed",
      finalAttempt: false,
      error: { retryable: false },
    });
  });

  it("leaves a retryable failure for BullMQ to retry", async () => {
    const handler = makeHandler(
      "media.probe",
      async () => {
        throw transientFailure("media/store_unavailable", "the store said no");
      },
      h.services,
      new AbortController().signal,
    );
    const thrown = await handler(fakeJob(envelope(), 0, 3)).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(MediaJobError);
    expect(thrown).not.toBeInstanceOf(UnrecoverableError);
  });

  it("does not let BullMQ retry a job whose data is not an envelope", async () => {
    const handler = makeHandler(
      "media.probe",
      async () => ({ result: {} }),
      h.services,
      new AbortController().signal,
    );
    await expect(handler(fakeJob({ nope: true }))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("does not run a job whose row the API has already settled", async () => {
    // A cancelled run, or an earlier attempt that already completed: nothing
    // this attempt does can be recorded, so it must not download anything.
    for (const reason of ["already_completed", "stale_attempt"]) {
      const paths: string[] = [];
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        paths.push(new URL(String(url)).pathname);
        return new Response(
          JSON.stringify({ applied: false, jobId: JOB, status: "cancelled", reason }),
          { status: 200 },
        );
      });
      const services: Services = {
        ...h.services,
        callbacks: new CallbackClient("http://api.test", "s".repeat(40), {
          fetch: fetchImpl as unknown as typeof globalThis.fetch,
        }),
      };
      const processor = vi.fn(async () => ({ result: {} }));
      const handler = makeHandler("media.probe", processor, services, new AbortController().signal);

      await expect(handler(fakeJob(envelope(), 2, 3)), reason).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(processor).not.toHaveBeenCalled();
      // No failure report either: the row is closed, and on a final attempt it
      // would otherwise have been PATCHed `failed` under a finished job.
      expect(paths, reason).toEqual([`/internal/jobs/${JOB}/progress`]);
    }
  });

  it("does not re-run the work when the API refuses its completion", async () => {
    // A 4xx means the API read the request and said no; downloading or
    // encoding everything again produces the same request.
    const refused = harness((path, body) =>
      path.endsWith("/complete") && body["status"] === "succeeded" ? 409 : 200,
    );
    const processor = vi.fn(async () => ({ result: { ok: true } }));
    const handler = makeHandler(
      "media.probe",
      processor,
      refused.services,
      new AbortController().signal,
    );
    const job = fakeJob(envelope(), 0, 3);
    await expect(handler(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(processor).toHaveBeenCalledTimes(1);
    // Refused is heard: nothing is carried to an attempt that would be refused too.
    expect(job.updateData).not.toHaveBeenCalled();
    const failed = refused.calls.find(
      (call) => call.path.endsWith("/complete") && call.body["status"] === "failed",
    );
    expect(failed?.body).toMatchObject({
      error: { code: "worker/callback_rejected", retryable: false },
    });
  });
});

describe("makeHandler when the API cannot hear the outcome", () => {
  /**
   * An API that is unreachable for the durable callbacks until `up()`, with the
   * durable budget cut to two quick tries. The pickup heartbeat always lands:
   * a worker restart and an API restart are different outages.
   */
  function outage(): Recorded & { up(): void } {
    let reachable = false;
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (!reachable && !path.endsWith("/progress")) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ applied: true, jobId: JOB, status: "running" }), {
        status: 200,
      });
    });
    return {
      calls,
      services: {
        ...h.services,
        callbacks: new CallbackClient("http://api.test", "s".repeat(40), {
          fetch: fetchImpl as unknown as typeof globalThis.fetch,
          maxAttempts: 2,
          backoffMs: 1,
          durableBudgetMs: 0,
        }),
      },
      up: () => {
        reachable = true;
      },
    };
  }

  /** The next BullMQ attempt of the same job, which sees whatever data it was left. */
  const nextAttempt = (job: Job): void => {
    (job as { attemptsMade: number }).attemptsMade += 1;
  };

  const carried = (job: Job): Record<string, unknown> | undefined =>
    (job.data as { pendingOutcome?: Record<string, unknown> }).pendingOutcome;

  it("carries a failure nobody heard to the next attempt, which reports it and runs nothing", async () => {
    // Ending the job here, as UnrecoverableError, left its row `running` and
    // the run spinning for good: production has no sweep to rescue it.
    const api = outage();
    const processor = vi.fn(async () => {
      throw unreadableMedia("no good", "media/corrupt");
    });
    const handler = makeHandler("media.probe", processor, api.services, new AbortController().signal);
    const job = fakeJob(envelope(), 0, 3);

    const first = await handler(job).catch((error: unknown) => error);
    expect(first).not.toBeInstanceOf(UnrecoverableError);
    expect(first).toMatchObject({ code: "worker/outcome_undelivered", retryable: true });
    expect(carried(job)).toMatchObject({
      attemptId: ATTEMPT,
      mediaPatch: { status: "failed", failureReason: "media/corrupt" },
      completion: { status: "failed", error: { code: "media/unreadable", retryable: false } },
    });

    api.up();
    api.calls.length = 0;
    nextAttempt(job);
    const second = await handler(job).catch((error: unknown) => error);
    // Heard now, and still not something BullMQ should run a third time.
    expect(second).toBeInstanceOf(UnrecoverableError);
    expect((second as Error).message).toBe("no good");
    expect(processor).toHaveBeenCalledTimes(1);
    expect(api.calls.map((call) => call.path)).toEqual([
      `/internal/media/${MEDIA}`,
      `/internal/jobs/${JOB}/complete`,
    ]);
    expect(api.calls[1]?.body).toMatchObject({
      status: "failed",
      error: { code: "media/unreadable", retryable: false },
    });
  });

  it("delivers a result nobody heard on the next attempt, without doing the work again", async () => {
    // A finished download whose completion was lost to an API restart used to
    // be downloaded again, whole, by BullMQ's retry.
    const api = outage();
    const processor = vi.fn(async () => ({
      result: { mediaId: MEDIA, durationMs: 10_000 },
      mediaPatch: { durationMs: 10_000 },
      usage: { mediaSeconds: 10 },
    }));
    const handler = makeHandler("media.probe", processor, api.services, new AbortController().signal);
    const job = fakeJob(envelope(), 0, 3);

    const first = await handler(job).catch((error: unknown) => error);
    expect(first).toMatchObject({ code: "worker/outcome_undelivered", retryable: true });
    // Not reported as a failure while an attempt remains to deliver the success.
    expect(api.calls.some((call) => call.body["status"] === "failed")).toBe(false);

    api.up();
    api.calls.length = 0;
    nextAttempt(job);
    await expect(handler(job)).resolves.toEqual({ mediaId: MEDIA, durationMs: 10_000 });
    expect(processor).toHaveBeenCalledTimes(1);
    expect(api.calls.map((call) => call.path)).toEqual([
      `/internal/media/${MEDIA}`,
      `/internal/jobs/${JOB}/complete`,
    ]);
    expect(api.calls[0]?.body).toEqual({ durationMs: 10_000 });
    expect(api.calls[1]?.body).toMatchObject({
      status: "succeeded",
      result: { mediaId: MEDIA, durationMs: 10_000 },
      usage: { mediaSeconds: 10 },
    });
  });

  it("keeps carrying while the API stays down, and ends the job when the attempts do", async () => {
    const api = outage();
    const processor = vi.fn(async () => {
      throw unreadableMedia("no good", "media/corrupt");
    });
    const handler = makeHandler("media.probe", processor, api.services, new AbortController().signal);
    const job = fakeJob(envelope(), 0, 3);

    await expect(handler(job)).rejects.not.toBeInstanceOf(UnrecoverableError);
    nextAttempt(job);
    await expect(handler(job)).rejects.not.toBeInstanceOf(UnrecoverableError);
    nextAttempt(job);
    // The last attempt: nothing left to carry it to.
    await expect(handler(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it("ends an unheard failure on the final attempt, as before, with nothing carried", async () => {
    const api = outage();
    const handler = makeHandler(
      "media.probe",
      async () => {
        throw unreadableMedia("no good", "media/corrupt");
      },
      api.services,
      new AbortController().signal,
    );
    const job = fakeJob(envelope(), 2, 3);
    await expect(handler(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(carried(job)).toBeUndefined();
  });

  it("runs afresh when what is carried belongs to another attempt, as a DLQ replay's does", async () => {
    const processor = vi.fn(async () => ({ result: { fresh: true } }));
    const handler = makeHandler("media.probe", processor, h.services, new AbortController().signal);
    const replayed = fakeJob({
      ...envelope(),
      pendingOutcome: {
        attemptId: "01JCOLDATTEMPT000000000000",
        completion: { status: "succeeded", result: { stale: true } },
      },
    });
    await expect(handler(replayed)).resolves.toEqual({ fresh: true });
    expect(processor).toHaveBeenCalledTimes(1);
  });
});

describe("makeHandler on media.acquire", () => {
  const acquireEnvelope = (): Record<string, unknown> =>
    envelope({
      jobKey: `media.acquire:${MEDIA}`,
      payload: { mediaId: MEDIA, destination: { key: `${PREFIX}/raw.mp4` } },
    });

  it("writes the source's own reason to the media row, and runs once", async () => {
    const handler = makeHandler(
      "media.acquire",
      async () => {
        throw sourceRefused("media/source_blocked", "the video site is refusing us for now");
      },
      h.services,
      new AbortController().signal,
    );
    await expect(
      handler(fakeJob(acquireEnvelope(), 0, 3, "media.acquire")),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const patch = h.calls.find((call) => call.path === `/internal/media/${MEDIA}`);
    expect(patch?.body).toEqual({ status: "failed", failureReason: "media/source_blocked" });
    const completion = h.calls.find((call) => call.path.endsWith("/complete"));
    expect(completion?.body).toMatchObject({
      error: { code: "media/source_blocked", retryable: false },
    });
  });

  it("says the download failed, not the probe, when a failure brings no reason", async () => {
    // Anything unnamed from acquisition — a store error, an ENOENT — used to
    // reach the user as `media/probe_failed`.
    const handler = makeHandler(
      "media.acquire",
      async () => {
        throw new Error("ENOENT: no such file or directory");
      },
      h.services,
      new AbortController().signal,
    );
    await expect(handler(fakeJob(acquireEnvelope(), 2, 3, "media.acquire"))).rejects.toThrow(
      /ENOENT/,
    );
    const patch = h.calls.find((call) => call.path === `/internal/media/${MEDIA}`);
    expect(patch?.body).toEqual({ status: "failed", failureReason: "media/source_failed" });
  });

  it("keeps probe_failed as the fallback for the queues that read our own files", async () => {
    const handler = makeHandler(
      "media.probe",
      async () => {
        throw new Error("boom");
      },
      h.services,
      new AbortController().signal,
    );
    await expect(handler(fakeJob(envelope(), 2, 3))).rejects.toThrow("boom");
    const patch = h.calls.find((call) => call.path === `/internal/media/${MEDIA}`);
    expect(patch?.body).toEqual({ status: "failed", failureReason: "media/probe_failed" });
  });

  it("marks no media row for a clip job, which has none", async () => {
    const handler = makeHandler(
      "media.clip",
      async () => {
        throw unreadableMedia("no good", "media/corrupt");
      },
      h.services,
      new AbortController().signal,
    );
    const clip = envelope({
      jobKey: "media.clip:01JCC1PP000000000000000000",
      payload: { clipId: "01JCC1PP000000000000000000", destination: { key: `${PREFIX}/clip.mp4` } },
    });
    await expect(handler(fakeJob(clip, 0, 3, "media.clip"))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(h.calls.some((call) => call.path.startsWith("/internal/media/"))).toBe(false);
    expect(h.calls.some((call) => call.path.endsWith("/complete"))).toBe(true);
  });
});

describe("Heartbeat", () => {
  let now = 0;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Let a fire-and-forget post settle, so the next one is not dropped as in flight. */
  const settle = async (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("posts a real move in progress without waiting out the lock-sized interval", async () => {
    // The interval is a third of the lock — 200 s on media.acquire — and a
    // 90-second download that only posted on it sat at 5% from start to end.
    const progress = h.calls;
    const beat = new Heartbeat(h.services.callbacks, JOB, ATTEMPT, 200_000);
    await beat.postNow(5);

    now += MIN_PROGRESS_POST_MS;
    beat.report(7); // moved 2 points: not news yet
    await settle();
    beat.report(31); // moved 26 points: news
    await settle();
    now += 100;
    beat.report(50); // news, but too soon after the last post
    await settle();
    now += MIN_PROGRESS_POST_MS;
    beat.report(52); // 21 points past the last POSTED value
    await settle();

    expect(progress.map((call) => call.body["progress"])).toEqual([5, 31, 52]);
  });

  it("still re-posts on the interval when nothing has moved", async () => {
    const beat = new Heartbeat(h.services.callbacks, JOB, ATTEMPT, 200_000);
    await beat.postNow(40);
    now += 200_000;
    beat.report(40);
    await settle();
    expect(h.calls.map((call) => call.body["progress"])).toEqual([40, 40]);
  });
});
