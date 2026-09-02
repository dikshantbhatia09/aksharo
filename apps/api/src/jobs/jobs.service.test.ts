import { HttpStatus } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdmissionService } from "./admission.service.js";
import { createFakePrisma, FakeDb, FakeQueueRegistry } from "../../test/fakes.js";
import { AppException } from "../common/errors/error-codes.js";
import { MetricsService } from "../common/metrics/metrics.service.js";
import { CreditsInsufficientError } from "../credits/credits.facade.js";
import { isJobEnvelope } from "./contracts/job-envelope.js";
import { DlqService } from "./dlq.service.js";
import { JobEventsService } from "./job-events.service.js";
import { PLAN_MAX_QUEUE_WAIT_MS, PLAN_PRIORITY } from "./jobs.config.js";
import { JobsService } from "./jobs.service.js";

import type { QueueRegistry } from "./queue.registry.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { CreditsFacade } from "../credits/credits.facade.js";
import type { RealtimePublisher } from "../realtime/realtime.publisher.js";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPROJECT000000000000000";

interface Harness {
  jobs: JobsService;
  dlq: DlqService;
  metrics: MetricsService;
  db: FakeDb;
  queues: FakeQueueRegistry;
  credits: {
    reserve: ReturnType<typeof vi.fn>;
    settle: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    grantLot: ReturnType<typeof vi.fn>;
  };
  realtime: {
    jobProgress: ReturnType<typeof vi.fn>;
    jobCompleted: ReturnType<typeof vi.fn>;
  };
}

function harness(): Harness {
  const db = new FakeDb();
  const prisma = createFakePrisma(db) as unknown as PrismaService;
  const queues = new FakeQueueRegistry();
  const credits = {
    reserve: vi.fn(async () => ({ holdId: "hold-1" })),
    settle: vi.fn(async () => ({ settledTenths: 0 })),
    release: vi.fn(async () => undefined),
    grantLot: vi.fn(async () => ({ lotId: "lot-1" })),
  };
  const realtime = {
    jobProgress: vi.fn(async () => undefined),
    jobCompleted: vi.fn(async () => undefined),
  };

  const metrics = new MetricsService();
  const events = new JobEventsService(prisma);
  const dlq = new DlqService(
    prisma,
    queues as unknown as QueueRegistry,
    events,
    metrics,
    realtime as unknown as RealtimePublisher,
    credits as unknown as CreditsFacade,
  );
  const jobs = new JobsService(
    prisma,
    queues as unknown as QueueRegistry,
    new AdmissionService(prisma),
    events,
    realtime as unknown as RealtimePublisher,
    dlq,
    metrics,
    credits as unknown as CreditsFacade,
  );

  return { jobs, dlq, metrics, db, queues, credits, realtime };
}

const ENQUEUE = {
  type: "ai.transcribe",
  workspaceId: WS,
  projectId: PROJECT,
  params: { mediaId: "01JCMEDIA00000000000000000" },
  jobKey: "transcribe:01JCMEDIA00000000000000000",
  worstCaseTenths: 120,
};

let h: Harness;
beforeEach(() => {
  h = harness();
  h.db.plans.set(WS, "creator");
});

describe("enqueue", () => {
  it("creates the row, reserves credits and adds the BullMQ job with the envelope", async () => {
    const { job, deduplicated } = await h.jobs.enqueue(ENQUEUE);

    expect(deduplicated).toBe(false);
    expect(job.status).toBe("queued");
    expect(job.priority).toBe(PLAN_PRIORITY.creator);
    expect(job.maxQueueWaitMs).toBe(PLAN_MAX_QUEUE_WAIT_MS.creator);
    expect(job.creditsChargedTenths).toBe(120);
    expect(job.creditHoldId).toBe("hold-1");

    expect(h.credits.reserve).toHaveBeenCalledWith({
      workspaceId: WS,
      jobId: job.id,
      worstCaseTenths: 120,
      reason: expect.stringContaining("ai.transcribe"),
    });

    const added = h.queues.added[0];
    expect(added?.queue).toBe("ai.transcribe");
    expect(isJobEnvelope(added?.data)).toBe(true);
    expect(added?.data).toMatchObject({
      jobId: job.id,
      attemptId: job.attemptId,
      workspaceId: WS,
      projectId: PROJECT,
      priority: PLAN_PRIORITY.creator,
      jobKey: ENQUEUE.jobKey,
      payload: ENQUEUE.params,
    });
    expect(added?.options["jobId"]).toBe(`${job.id}-${String(job.attemptId)}`);
  });

  it("reserves BEFORE the job reaches the queue", async () => {
    const order: string[] = [];
    h.credits.reserve.mockImplementation(async () => {
      order.push("reserve");
      return { holdId: "hold-1" };
    });
    const queue = h.queues.queue("ai.transcribe");
    const add = queue.add.bind(queue);
    vi.spyOn(h.queues, "queue").mockReturnValue({
      ...queue,
      add: async (...args: Parameters<typeof add>) => {
        order.push("enqueue");
        return add(...args);
      },
    } as ReturnType<FakeQueueRegistry["queue"]>);

    await h.jobs.enqueue(ENQUEUE);
    expect(order).toEqual(["reserve", "enqueue"]);
  });

  it("records a job.queued event", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    expect(h.db.eventNames(job.id)).toEqual(["job.queued"]);
  });

  it("is idempotent by jobKey while a job is live", async () => {
    const first = await h.jobs.enqueue(ENQUEUE);
    const second = await h.jobs.enqueue(ENQUEUE);

    expect(second.deduplicated).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(h.queues.added).toHaveLength(1);
    expect(h.credits.reserve).toHaveBeenCalledTimes(1);
  });

  it("enqueues again once the previous job with that key has finished", async () => {
    const first = await h.jobs.enqueue(ENQUEUE);
    await h.jobs.complete(first.job.id, first.job.attemptId ?? "", { status: "succeeded" });

    const second = await h.jobs.enqueue(ENQUEUE);
    expect(second.deduplicated).toBe(false);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it("rejects a type that is not a CONTRACTS §3 queue", async () => {
    const failure = await h.jobs
      .enqueue({ ...ENQUEUE, type: "ai.hallucinate" })
      .catch((error: unknown) => error);
    expect((failure as AppException).code).toBe("jobs/invalid_type");
    expect((failure as AppException).httpStatus).toBe(HttpStatus.BAD_REQUEST);
  });

  it("deletes the row and enqueues nothing when the reservation fails", async () => {
    h.credits.reserve.mockRejectedValueOnce(new CreditsInsufficientError(50));

    await expect(h.jobs.enqueue(ENQUEUE)).rejects.toBeInstanceOf(CreditsInsufficientError);
    expect(h.db.jobs.size).toBe(0);
    expect(h.queues.added).toHaveLength(0);
  });

  it("releases the hold and fails the row when the queue is unreachable", async () => {
    h.queues.failNextAdd = true;

    const failure = await h.jobs.enqueue(ENQUEUE).catch((error: unknown) => error);

    expect((failure as AppException).code).toBe("common/unavailable");
    expect((failure as AppException).httpStatus).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(h.credits.release).toHaveBeenCalledWith({ holdId: "hold-1" });
    const [job] = [...h.db.jobs.values()];
    expect(job?.status).toBe("failed");
    expect(job?.creditsChargedTenths).toBe(0);
  });

  it("omits projectId from the envelope for a workspace-level job", async () => {
    const { job } = await h.jobs.enqueue({ ...ENQUEUE, projectId: null, type: "notify" });
    expect(job.projectId).toBeNull();
    expect(h.queues.added[0]?.data).not.toHaveProperty("projectId");
  });

  it("honours an explicit priority override", async () => {
    const { job } = await h.jobs.enqueue({ ...ENQUEUE, priority: 1 });
    expect(job.priority).toBe(1);
  });
});

describe("get and list", () => {
  it("scopes reads to the caller's workspace (T5)", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    await expect(h.jobs.get(job.id, WS)).resolves.toMatchObject({ id: job.id });

    const failure = await h.jobs
      .get(job.id, "01JCWS0000000000000000000B")
      .catch((error: unknown) => error);
    expect((failure as AppException).code).toBe("jobs/not_found");
    expect((failure as AppException).httpStatus).toBe(HttpStatus.NOT_FOUND);
  });

  it("pages newest first with a cursor", async () => {
    for (let index = 0; index < 5; index += 1) {
      h.db.job({ workspaceId: WS, id: `01JCJOB000000000000000000${String(index)}` });
    }

    const first = await h.jobs.list({ workspaceId: WS, limit: 2 });
    expect(first.items.map((job) => job.id)).toEqual([
      "01JCJOB0000000000000000004",
      "01JCJOB0000000000000000003",
    ]);
    expect(first.nextCursor).toBe("01JCJOB0000000000000000003");

    const second = await h.jobs.list({ workspaceId: WS, limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.items.map((job) => job.id)).toEqual([
      "01JCJOB0000000000000000002",
      "01JCJOB0000000000000000001",
    ]);

    const last = await h.jobs.list({ workspaceId: WS, limit: 10 });
    expect(last.nextCursor).toBeNull();
  });

  it("filters by status, type and project", async () => {
    h.db.job({ workspaceId: WS, status: "failed", type: "notify", projectId: PROJECT });
    h.db.job({ workspaceId: WS, status: "queued", type: "ai.transcribe", projectId: null });

    await expect(h.jobs.list({ workspaceId: WS, status: "failed" })).resolves.toMatchObject({
      items: [{ type: "notify" }],
    });
    await expect(h.jobs.list({ workspaceId: WS, type: "notify" })).resolves.toMatchObject({
      items: [{ status: "failed" }],
    });
    await expect(h.jobs.list({ workspaceId: WS, projectId: PROJECT })).resolves.toMatchObject({
      items: [{ type: "notify" }],
    });
  });

  it("clamps the page size", async () => {
    for (let index = 0; index < 3; index += 1) h.db.job({ workspaceId: WS });
    await expect(h.jobs.list({ workspaceId: WS, limit: 0 })).resolves.toMatchObject({
      items: expect.any(Array),
    });
    await expect(h.jobs.list({ workspaceId: WS, limit: 10_000 })).resolves.toMatchObject({
      nextCursor: null,
    });
  });

  it("lists a job's events oldest first, workspace-scoped", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    await h.jobs.recordProgress(job.id, job.attemptId ?? "", { progress: 25 });

    const events = await h.jobs.listEvents(job.id, WS);
    expect(events.items.map((event) => event.message)).toEqual([
      "queued on ai.transcribe",
      "started",
      "progress 25%",
    ]);

    await expect(h.jobs.listEvents(job.id, "01JCWS0000000000000000000B")).rejects.toThrow();
  });

  it("stamps a 30-day retention marker on every event", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    const [event] = await h.jobs.listEvents(job.id, WS).then((page) => page.items);
    const data = event?.data as { retainUntil: string; retentionDays: number };
    expect(data.retentionDays).toBe(30);
    expect(Date.parse(data.retainUntil)).toBeGreaterThan(Date.now());
  });
});

describe("recordProgress", () => {
  it("promotes a queued job to running and publishes job.progress", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);

    const ack = await h.jobs.recordProgress(job.id, job.attemptId ?? "", {
      progress: 42.4,
      etaMs: 9_000,
      message: "chunk 3/7",
    });

    expect(ack).toMatchObject({ applied: true, status: "running" });
    const stored = h.db.jobs.get(job.id);
    expect(stored?.status).toBe("running");
    expect(stored?.progress).toBe(42);
    expect(stored?.startedAt).toBeInstanceOf(Date);
    expect(h.realtime.jobProgress).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, projectId: PROJECT }),
      { jobId: job.id, progress: 42.4, etaMs: 9_000, message: "chunk 3/7" },
    );
    expect(h.db.eventNames(job.id)).toEqual(["job.queued", "job.started", "job.progress"]);
  });

  it("records job.started only once", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    await h.jobs.recordProgress(job.id, job.attemptId ?? "", { progress: 10 });
    await h.jobs.recordProgress(job.id, job.attemptId ?? "", { progress: 20 });
    expect(h.db.eventNames(job.id).filter((name) => name === "job.started")).toHaveLength(1);
  });

  it("ignores a superseded attempt", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    const ack = await h.jobs.recordProgress(job.id, "01JCOLDATTEMPT000000000000", { progress: 5 });
    expect(ack).toMatchObject({ applied: false, reason: "stale_attempt" });
    expect(h.db.jobs.get(job.id)?.progress).toBe(0);
  });

  it("ignores progress on a finished job", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    await h.jobs.complete(job.id, job.attemptId ?? "", { status: "succeeded" });
    const ack = await h.jobs.recordProgress(job.id, job.attemptId ?? "", { progress: 50 });
    expect(ack).toMatchObject({ applied: false, reason: "already_completed" });
  });

  it("404s for a job that does not exist", async () => {
    await expect(h.jobs.recordProgress("nope", "a", { progress: 1 })).rejects.toBeInstanceOf(
      AppException,
    );
  });
});

describe("complete (THREAT-MODEL T8/T9)", () => {
  it("settles once, records the result and publishes job.completed", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);

    const ack = await h.jobs.complete(job.id, job.attemptId ?? "", {
      status: "succeeded",
      result: { transcriptId: "01JCTRANSCRIPT0000000000000" },
      usage: {
        actualTenths: 80,
        provider: "sarvam",
        model: "saarika-v2",
        costMinor: 42,
        egressBytes: 1_024,
      },
    });

    expect(ack).toMatchObject({ applied: true, status: "succeeded" });
    expect(h.credits.settle).toHaveBeenCalledTimes(1);
    expect(h.credits.settle).toHaveBeenCalledWith({ holdId: "hold-1", actualTenths: 80 });

    const stored = h.db.jobs.get(job.id);
    expect(stored?.status).toBe("succeeded");
    expect(stored?.progress).toBe(100);
    expect(stored?.creditsChargedTenths).toBe(80);
    expect(stored?.provider).toBe("sarvam");
    expect(stored?.model).toBe("saarika-v2");
    expect(h.realtime.jobCompleted).toHaveBeenCalledTimes(1);
  });

  it("REPLAYS return 200 and settle exactly once", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    const body = { status: "succeeded" as const, usage: { actualTenths: 60 } };

    const first = await h.jobs.complete(job.id, job.attemptId ?? "", body);
    const second = await h.jobs.complete(job.id, job.attemptId ?? "", body);
    const third = await h.jobs.complete(job.id, job.attemptId ?? "", body);

    expect(first.applied).toBe(true);
    expect(second).toMatchObject({ applied: false, reason: "already_completed" });
    expect(third.applied).toBe(false);
    expect(h.credits.settle).toHaveBeenCalledTimes(1);
    expect(h.realtime.jobCompleted).toHaveBeenCalledTimes(1);
  });

  it("ignores a completion from a superseded attempt", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    const ack = await h.jobs.complete(job.id, "01JCOLDATTEMPT000000000000", { status: "failed" });
    expect(ack).toMatchObject({ applied: false, reason: "stale_attempt" });
    expect(h.credits.settle).not.toHaveBeenCalled();
    expect(h.credits.release).not.toHaveBeenCalled();
    expect(h.db.jobs.get(job.id)?.status).toBe("queued");
  });

  it("settles the full hold when the worker reports no figure", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    await h.jobs.complete(job.id, job.attemptId ?? "", { status: "succeeded" });
    expect(h.credits.settle).toHaveBeenCalledWith({ holdId: "hold-1", actualTenths: 120 });
  });

  it("never settles more than was held", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    await h.jobs.complete(job.id, job.attemptId ?? "", {
      status: "succeeded",
      usage: { actualTenths: 10_000 },
    });
    expect(h.credits.settle).toHaveBeenCalledWith({ holdId: "hold-1", actualTenths: 120 });
  });

  it("releases the hold on failure and charges nothing", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);

    const ack = await h.jobs.complete(job.id, job.attemptId ?? "", {
      status: "failed",
      error: { code: "provider/timeout", message: "upstream timed out", retryable: true },
    });

    expect(ack).toMatchObject({ applied: true, status: "failed" });
    expect(h.credits.release).toHaveBeenCalledWith({ holdId: "hold-1" });
    expect(h.credits.settle).not.toHaveBeenCalled();
    expect(h.db.jobs.get(job.id)?.creditsChargedTenths).toBe(0);
    expect(h.db.eventNames(job.id)).toContain("job.failed");
  });

  it("marks a dead letter when the attempt was the last one", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    await h.jobs.complete(job.id, job.attemptId ?? "", {
      status: "failed",
      finalAttempt: true,
      error: { code: "provider/timeout", message: "gave up", retryable: true },
    });
    expect(h.db.eventNames(job.id)).toContain("job.dead_lettered");
  });

  it("marks a dead letter when the error is not retryable", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    await h.jobs.complete(job.id, job.attemptId ?? "", {
      status: "failed",
      error: { code: "media/corrupt", message: "not decodable", retryable: false },
    });
    expect(h.db.eventNames(job.id)).toContain("job.dead_lettered");
  });

  it("does not dead-letter a retryable failure with attempts left", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    await h.jobs.complete(job.id, job.attemptId ?? "", {
      status: "failed",
      error: { code: "provider/timeout", message: "retrying", retryable: true },
    });
    expect(h.db.eventNames(job.id)).not.toContain("job.dead_lettered");
  });

  it("404s for a job that does not exist", async () => {
    await expect(h.jobs.complete("nope", "a", { status: "succeeded" })).rejects.toBeInstanceOf(
      AppException,
    );
  });
});

describe("cancel", () => {
  it("cancels a queued job, releases the hold and removes the queue entry", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);

    const cancelled = await h.jobs.cancel(job.id, WS);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.creditsChargedTenths).toBe(0);
    expect(h.credits.release).toHaveBeenCalledWith({ holdId: "hold-1" });
    expect(h.queues.removed).toEqual([`${job.id}-${String(job.attemptId)}`]);
    expect(h.realtime.jobCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: job.id }),
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("refuses to cancel a finished job", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    await h.jobs.complete(job.id, job.attemptId ?? "", { status: "succeeded" });

    const failure = await h.jobs.cancel(job.id, WS).catch((error: unknown) => error);
    expect((failure as AppException).code).toBe("jobs/invalid_state");
    expect((failure as AppException).httpStatus).toBe(HttpStatus.CONFLICT);
  });

  it("404s on another workspace's job", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    await expect(h.jobs.cancel(job.id, "01JCWS0000000000000000000B")).rejects.toMatchObject({
      code: "jobs/not_found",
    });
  });
});

describe("timeOut", () => {
  it("fails a stale queued job and releases its hold", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);

    await expect(h.jobs.timeOut(h.db.jobs.get(job.id) as never)).resolves.toBe(true);

    const stored = h.db.jobs.get(job.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.creditsChargedTenths).toBe(0);
    expect((stored?.error as { code: string }).code).toBe("jobs/queue_timeout");
    expect(h.credits.release).toHaveBeenCalledWith({ holdId: "hold-1" });
    expect(h.db.eventNames(job.id)).toContain("job.timed_out");
  });

  it("refuses a job a worker has already started", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    const snapshot = h.db.jobs.get(job.id) as never;
    await h.jobs.recordProgress(job.id, job.attemptId ?? "", { progress: 1 });

    await expect(h.jobs.timeOut(snapshot)).resolves.toBe(false);
    expect(h.db.jobs.get(job.id)?.status).toBe("running");
  });
});

describe("enqueueChild", () => {
  it("inherits the parent's workspace and project and links both ways", async () => {
    const parent = (await h.jobs.enqueue(ENQUEUE)).job;

    const child = await h.jobs.enqueueChild(parent, {
      type: "media.proxy",
      payload: { mediaId: "01JCMEDIA00000000000000000" },
      worstCaseTenths: 0,
    });

    expect(child.job.workspaceId).toBe(parent.workspaceId);
    expect(child.job.projectId).toBe(parent.projectId);
    expect(child.job.jobKey).toBe(`${parent.jobKey}:media.proxy`);
    expect(h.db.eventNames(parent.id)).toContain("job.child_enqueued");
  });

  it("cannot fan out twice for the same follow-up", async () => {
    const parent = (await h.jobs.enqueue(ENQUEUE)).job;
    const first = await h.jobs.enqueueChild(parent, {
      type: "media.proxy",
      payload: {},
      worstCaseTenths: 0,
    });
    const second = await h.jobs.enqueueChild(parent, {
      type: "media.proxy",
      payload: {},
      worstCaseTenths: 0,
    });
    expect(second.deduplicated).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });
});

describe("envelopeFor", () => {
  it("rebuilds the envelope a stored job was enqueued with", async () => {
    const { job } = await h.jobs.enqueue(ENQUEUE);
    expect(h.jobs.envelopeFor(job)).toEqual(h.queues.added[0]?.data);
  });
});
