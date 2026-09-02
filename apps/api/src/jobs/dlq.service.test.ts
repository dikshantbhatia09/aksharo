import { HttpStatus } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdmissionService } from "./admission.service.js";
import { DlqService } from "./dlq.service.js";
import { JobEventsService } from "./job-events.service.js";
import { JOB_ERROR_CODES } from "./jobs.errors.js";
import { JobsService } from "./jobs.service.js";
import { createFakePrisma, FakeDb, FakeQueueRegistry } from "../../test/fakes.js";
import { AppException } from "../common/errors/error-codes.js";
import { METRIC, MetricsService } from "../common/metrics/metrics.service.js";

import type { QueueRegistry } from "./queue.registry.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { CreditsFacade } from "../credits/credits.facade.js";
import type { RealtimePublisher } from "../realtime/realtime.publisher.js";

const WS = "01JCWS0000000000000000000A";
const ADMIN = { userId: "01JCADMIN00000000000000000" };

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
}

function harness(): Harness {
  const db = new FakeDb();
  const prisma = createFakePrisma(db) as unknown as PrismaService;
  const queues = new FakeQueueRegistry();
  const credits = {
    reserve: vi.fn(async () => ({ holdId: "hold-replay" })),
    settle: vi.fn(async () => ({ settledTenths: 0 })),
    release: vi.fn(async () => undefined),
    grantLot: vi.fn(async () => ({ lotId: "lot-1" })),
  };
  const realtime = {
    jobProgress: vi.fn(async () => undefined),
    jobCompleted: vi.fn(async () => undefined),
  } as unknown as RealtimePublisher;

  const metrics = new MetricsService();
  const events = new JobEventsService(prisma);
  const dlq = new DlqService(
    prisma,
    queues as unknown as QueueRegistry,
    events,
    metrics,
    realtime,
    credits as unknown as CreditsFacade,
  );
  const jobs = new JobsService(
    prisma,
    queues as unknown as QueueRegistry,
    new AdmissionService(prisma),
    events,
    realtime,
    dlq,
    metrics,
    credits as unknown as CreditsFacade,
  );
  return { jobs, dlq, metrics, db, queues, credits };
}

let h: Harness;
beforeEach(() => {
  h = harness();
  h.db.plans.set(WS, "creator");
});

/** A job that has burnt its retry budget and is sitting in `failed`. */
function deadLettered(overrides: Record<string, unknown> = {}) {
  const job = h.db.job({
    workspaceId: WS,
    type: "ai.transcribe",
    status: "failed",
    attemptNo: 3,
    creditsChargedTenths: 0,
    creditHoldId: "hold-1",
    dlq: true,
    dlqReason: "provider/timeout",
    dlqAt: new Date(),
    ...overrides,
  });
  const entry = h.db.dlqEntry({
    jobId: job.id,
    workspaceId: job.workspaceId,
    queue: job.type,
    jobKey: job.jobKey,
    attemptId: job.attemptId ?? job.id,
    attemptNo: job.attemptNo,
    attempts: job.attemptNo,
    payload: { mediaId: "01JCMEDIA00000000000000000" },
    lastError: { code: "provider/timeout", message: "upstream timed out", retryable: true },
    worstCaseTenths: 120,
  });
  return { job, entry };
}

describe("record", () => {
  it("copies the failed job, marks the row and keeps the hold amount for a replay", async () => {
    const job = h.db.job({
      workspaceId: WS,
      status: "running",
      attemptNo: 3,
      // Still the HOLD at this point: `complete` overwrites it afterwards.
      creditsChargedTenths: 120,
    });

    const entry = await h.dlq.record(job, {
      status: "failed",
      finalAttempt: true,
      error: { code: "provider/timeout", message: "upstream timed out", retryable: true },
    });

    expect(entry.jobId).toBe(job.id);
    expect(entry.queue).toBe(job.type);
    expect(entry.attemptId).toBe(job.attemptId);
    expect(entry.attempts).toBe(3);
    expect(entry.worstCaseTenths).toBe(120);
    expect(entry.lastError).toMatchObject({ code: "provider/timeout" });
    expect(entry.status).toBe("pending");

    const marked = h.db.jobs.get(job.id);
    expect(marked?.dlq).toBe(true);
    expect(marked?.dlqReason).toBe("provider/timeout");
    expect(h.db.eventNames(job.id)).toContain("job.dead_lettered");
  });

  it("is idempotent on (jobId, attemptId), because a callback is at-least-once", async () => {
    const job = h.db.job({ workspaceId: WS, status: "running", creditsChargedTenths: 50 });
    const body = { status: "failed" as const, finalAttempt: true };

    const first = await h.dlq.record(job, body);
    const second = await h.dlq.record(job, body);

    expect(second.id).toBe(first.id);
    expect(h.db.dlq.size).toBe(1);
  });

  it("publishes the per-queue depth gauge under both metric names", async () => {
    const job = h.db.job({ workspaceId: WS, type: "render.video", status: "running" });
    await h.dlq.record(job, { status: "failed", finalAttempt: true });

    expect(h.metrics.registry.value(METRIC.dlqDepth, { queue: "render.video" })).toBe(1);
    expect(h.metrics.registry.value(METRIC.aliasDlqDepth, { queue: "render.video" })).toBe(1);
  });
});

describe("the completion path", () => {
  it("dead-letters on the final attempt and not before", async () => {
    const running = h.db.job({ workspaceId: WS, status: "running", creditsChargedTenths: 30 });
    await h.jobs.complete(running.id, running.attemptId ?? "", {
      status: "failed",
      error: { code: "provider/timeout", message: "retry me", retryable: true },
    });
    expect(h.db.dlq.size).toBe(0);

    const last = h.db.job({ workspaceId: WS, status: "running", creditsChargedTenths: 30 });
    await h.jobs.complete(last.id, last.attemptId ?? "", {
      status: "failed",
      finalAttempt: true,
      error: { code: "provider/timeout", message: "no attempts left", retryable: true },
    });
    expect(h.db.dlq.size).toBe(1);
    expect([...h.db.dlq.values()][0]?.jobId).toBe(last.id);
  });

  it("dead-letters immediately on an unretryable error, without burning the budget", async () => {
    const job = h.db.job({ workspaceId: WS, status: "running", creditsChargedTenths: 30 });
    await h.jobs.complete(job.id, job.attemptId ?? "", {
      status: "failed",
      error: { code: "media/unsupported", message: "no audio stream", retryable: false },
    });
    expect(h.db.dlq.size).toBe(1);
  });

  it("counts the failure under both the METRICS.md name and the brief's alias", async () => {
    const job = h.db.job({ workspaceId: WS, type: "ai.llm", status: "running", attemptNo: 2 });
    await h.jobs.complete(job.id, job.attemptId ?? "", { status: "failed", finalAttempt: true });

    expect(
      h.metrics.registry.value(METRIC.jobCompleted, { queue: "ai.llm", status: "failed" }),
    ).toBe(1);
    expect(h.metrics.registry.value(METRIC.aliasJobsFailed, { queue: "ai.llm" })).toBe(1);
    expect(h.metrics.registry.summary(METRIC.jobAttempts, { queue: "ai.llm" })).toEqual({
      count: 1,
      sum: 2,
    });
  });
});

describe("replay", () => {
  it("re-enqueues the same row with a fresh attempt id and the next ordinal", async () => {
    const { job, entry } = deadLettered();

    const result = await h.dlq.replay(entry.id, ADMIN);

    expect(result.jobId).toBe(job.id);
    expect(result.attemptNo).toBe(4);
    expect(result.attemptId).not.toBe(job.attemptId);

    const replayed = h.db.jobs.get(job.id);
    expect(replayed?.status).toBe("queued");
    expect(replayed?.attemptId).toBe(result.attemptId);
    expect(replayed?.attemptNo).toBe(4);
    expect(replayed?.dlq).toBe(false);
    // The dedupe key is untouched, so nothing else can claim this unit of work.
    expect(replayed?.jobKey).toBe(job.jobKey);
  });

  it("adds a BullMQ job whose id carries the NEW attempt", async () => {
    const { job, entry } = deadLettered();
    const result = await h.dlq.replay(entry.id, ADMIN);

    const added = h.queues.added[0];
    expect(added?.queue).toBe("ai.transcribe");
    expect(added?.options["jobId"]).toBe(`${job.id}-${result.attemptId}`);
    expect(added?.data).toMatchObject({
      jobId: job.id,
      attemptId: result.attemptId,
      jobKey: job.jobKey,
      payload: { mediaId: "01JCMEDIA00000000000000000" },
    });
  });

  it("reserves credits again, for the hold the dead letter remembered", async () => {
    const { job, entry } = deadLettered();
    await h.dlq.replay(entry.id, ADMIN);

    expect(h.credits.reserve).toHaveBeenCalledWith({
      workspaceId: WS,
      jobId: job.id,
      worstCaseTenths: 120,
      reason: expect.stringContaining("replay"),
    });
    expect(h.db.jobs.get(job.id)?.creditHoldId).toBe("hold-replay");
    expect(h.db.jobs.get(job.id)?.creditsChargedTenths).toBe(120);
  });

  it("makes the OLD attempt's late callback a no-op (THREAT-MODEL T8)", async () => {
    const { job, entry } = deadLettered();
    const staleAttempt = job.attemptId ?? "";
    await h.dlq.replay(entry.id, ADMIN);

    const ack = await h.jobs.complete(job.id, staleAttempt, { status: "succeeded" });

    expect(ack.applied).toBe(false);
    expect(ack.reason).toBe("stale_attempt");
    expect(h.credits.settle).not.toHaveBeenCalled();
  });

  it("lets exactly one of two concurrent replays through", async () => {
    const { entry } = deadLettered();

    const [first, second] = await Promise.allSettled([
      h.dlq.replay(entry.id, ADMIN),
      h.dlq.replay(entry.id, ADMIN),
    ]);
    const outcomes = [first.status, second.status].sort();

    expect(outcomes).toEqual(["fulfilled", "rejected"]);
    expect(h.queues.added).toHaveLength(1);
  });

  it("refuses a dead letter whose job has come back to life", async () => {
    const { job, entry } = deadLettered();
    h.db.jobs.set(job.id, { ...job, status: "succeeded" });

    await expect(h.dlq.replay(entry.id, ADMIN)).rejects.toMatchObject({
      code: JOB_ERROR_CODES.dlqJobNotFailed,
      httpStatus: HttpStatus.CONFLICT,
    });
    // and leaves the entry actionable rather than half-resolved
    expect(h.db.dlq.get(entry.id)?.status).toBe("pending");
  });

  it("refuses to replay twice", async () => {
    const { entry } = deadLettered();
    await h.dlq.replay(entry.id, ADMIN);

    await expect(h.dlq.replay(entry.id, ADMIN)).rejects.toMatchObject({
      code: JOB_ERROR_CODES.dlqAlreadyResolved,
      httpStatus: HttpStatus.CONFLICT,
    });
  });

  it("unwinds — hold released, job failed again, entry pending — when the queue is down", async () => {
    const { job, entry } = deadLettered();
    h.queues.failNextAdd = true;

    await expect(h.dlq.replay(entry.id, ADMIN)).rejects.toBeInstanceOf(AppException);

    expect(h.credits.release).toHaveBeenCalledWith({ holdId: "hold-replay" });
    const after = h.db.jobs.get(job.id);
    expect(after?.status).toBe("failed");
    expect(after?.attemptNo).toBe(3);
    expect(after?.dlq).toBe(true);
    expect(h.db.dlq.get(entry.id)?.status).toBe("pending");
  });

  it("does not enqueue anything when the reservation is refused", async () => {
    const { entry } = deadLettered();
    h.credits.reserve.mockRejectedValueOnce(new Error("no credits"));

    await expect(h.dlq.replay(entry.id, ADMIN)).rejects.toThrow("no credits");

    expect(h.queues.added).toHaveLength(0);
    expect(h.db.dlq.get(entry.id)?.status).toBe("pending");
  });

  it("audits, and records the replay on the job's own event log", async () => {
    const { job, entry } = deadLettered();
    await h.dlq.replay(entry.id, ADMIN);

    expect(h.db.eventNames(job.id)).toContain("job.replayed");
    expect(h.db.audit[0]).toMatchObject({
      action: "dlq.replay",
      resource: "dlq",
      resourceId: entry.id,
      actorId: ADMIN.userId,
      actorKind: "admin",
    });
  });

  it("accepts the job id as well as the entry id, which is what the runbook passes", async () => {
    const { job } = deadLettered();
    const result = await h.dlq.replay(job.id, ADMIN);
    expect(result.jobId).toBe(job.id);
  });
});

describe("discard", () => {
  it("releases the hold, records the reason and audits", async () => {
    const { job, entry } = deadLettered();

    const result = await h.dlq.discard(entry.id, "unsupported input", ADMIN);

    expect(result.holdReleased).toBe(true);
    expect(h.credits.release).toHaveBeenCalledWith({ holdId: "hold-1" });
    expect(h.db.dlq.get(entry.id)?.status).toBe("discarded");
    expect(h.db.dlq.get(entry.id)?.resolution).toBe("unsupported input");
    expect(h.db.jobs.get(job.id)?.creditHoldId).toBeNull();
    expect(h.db.eventNames(job.id)).toContain("job.dlq_discarded");
    expect(h.db.audit[0]).toMatchObject({ action: "dlq.discard", actorId: ADMIN.userId });
  });

  it("refuses a blank reason: the DLQ is the record of what could not be done", async () => {
    const { entry } = deadLettered();
    await expect(h.dlq.discard(entry.id, "   ", ADMIN)).rejects.toMatchObject({
      httpStatus: HttpStatus.BAD_REQUEST,
    });
    expect(h.db.dlq.get(entry.id)?.status).toBe("pending");
  });

  it("cannot discard something already replayed", async () => {
    const { entry } = deadLettered();
    await h.dlq.replay(entry.id, ADMIN);

    await expect(h.dlq.discard(entry.id, "too late", ADMIN)).rejects.toMatchObject({
      code: JOB_ERROR_CODES.dlqAlreadyResolved,
    });
  });

  it("counts the outcome", async () => {
    const { entry } = deadLettered();
    await h.dlq.discard(entry.id, "bad input", ADMIN);
    expect(
      h.metrics.registry.value(METRIC.dlqResolved, {
        queue: "ai.transcribe",
        outcome: "discarded",
      }),
    ).toBe(1);
  });
});

describe("list and get", () => {
  it("filters by queue and status, newest first", async () => {
    const older = h.db.dlqEntry({ queue: "ai.transcribe", workspaceId: WS });
    const newer = h.db.dlqEntry({ queue: "ai.transcribe", workspaceId: WS });
    h.db.dlqEntry({ queue: "render.video", workspaceId: WS });

    const page = await h.dlq.list({ queue: "ai.transcribe", status: "pending" });

    expect(page.items.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(page.nextCursor).toBeNull();
  });

  it("paginates on the entry id, which is a ULID and therefore ordered", async () => {
    for (let i = 0; i < 3; i += 1) h.db.dlqEntry({ queue: "notify", workspaceId: WS });

    const first = await h.dlq.list({ queue: "notify", limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]?.id);

    const second = await h.dlq.list({ queue: "notify", limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it("404s on an id that is neither an entry nor a job", async () => {
    await expect(h.dlq.get("01JCNOTHING0000000000000000")).rejects.toMatchObject({
      code: JOB_ERROR_CODES.dlqNotFound,
      httpStatus: HttpStatus.NOT_FOUND,
    });
  });
});

describe("bulk", () => {
  it("dry-runs by default: it reports and changes nothing", async () => {
    deadLettered();
    deadLettered();

    const outcome = await h.dlq.bulk(
      { action: "replay", queue: "ai.transcribe", dryRun: true },
      ADMIN,
    );

    expect(outcome.selected).toBe(2);
    expect(outcome.replayed).toBe(0);
    expect(outcome.entries.every((row) => row.outcome === "would_replay")).toBe(true);
    expect(h.queues.added).toHaveLength(0);
  });

  it("replays every selected entry when it is not a dry run", async () => {
    deadLettered();
    deadLettered();

    const outcome = await h.dlq.bulk(
      { action: "replay", queue: "ai.transcribe", dryRun: false },
      ADMIN,
    );

    expect(outcome.replayed).toBe(2);
    expect(outcome.failed).toBe(0);
    expect(h.queues.added).toHaveLength(2);
  });

  it("counts a failure and carries on, rather than aborting halfway", async () => {
    const first = deadLettered();
    deadLettered();
    // Make the first one unreplayable.
    h.db.jobs.set(first.job.id, { ...first.job, status: "succeeded" });

    const outcome = await h.dlq.bulk(
      { action: "replay", queue: "ai.transcribe", dryRun: false },
      ADMIN,
    );

    expect(outcome.selected).toBe(2);
    expect(outcome.replayed).toBe(1);
    expect(outcome.failed).toBe(1);
    expect(outcome.entries.filter((row) => row.outcome === "failed")).toHaveLength(1);
  });

  it("selects by explicit ids, entry or job", async () => {
    const { entry } = deadLettered();
    const other = deadLettered();

    const outcome = await h.dlq.bulk(
      { action: "replay", ids: [entry.id, other.job.id], dryRun: false },
      ADMIN,
    );

    expect(outcome.selected).toBe(2);
    expect(outcome.replayed).toBe(2);
  });

  it("refuses a bulk discard with no reason", async () => {
    deadLettered();
    await expect(
      h.dlq.bulk({ action: "discard", queue: "ai.transcribe", dryRun: false }, ADMIN),
    ).rejects.toMatchObject({ httpStatus: HttpStatus.BAD_REQUEST });
  });

  it("keeps the discard reason out of the error-text filter", async () => {
    const { entry } = deadLettered();

    // `lastError.message` is "upstream timed out"; the discard reason mentions
    // none of that, and must not be used to select rows.
    const outcome = await h.dlq.bulk(
      {
        action: "discard",
        queue: "ai.transcribe",
        discardReason: "media purged, cannot be recovered",
        dryRun: false,
      },
      ADMIN,
    );

    expect(outcome.discarded).toBe(1);
    expect(h.db.dlq.get(entry.id)?.resolution).toBe("media purged, cannot be recovered");
  });
});
