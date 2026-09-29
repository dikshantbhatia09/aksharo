import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";

import { MemoryPrisma, type Row } from "./memory-prisma.test-support.js";
import { bullIdOf, PublishQueue } from "./publish-queue.js";
import { PublishWorker } from "./publish-worker.js";
import { AUTO_ATTEMPTS } from "./publishing.constants.js";

import type { PostizClient } from "./postiz/postiz.client.js";
import type { PublishDispatcher } from "./publish-dispatcher.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { RedisService } from "../common/redis/redis.service.js";
import type { QueueRegistry } from "../jobs/queue.registry.js";

const WS = "01JCWS0000000000000000000A";
const NOW = Date.parse("2026-10-01T06:00:00Z");

function target(id: string, over: Row = {}): Row {
  return {
    id,
    workspaceId: WS,
    batchId: "01JCBATCH00000000000000000",
    status: "ready",
    attemptNo: 1,
    retryAfter: null,
    nextCheckAt: null,
    checkNo: 0,
    createdAt: new Date(NOW - 10 * 60_000),
    updatedAt: new Date(NOW - 10 * 60_000),
    ...over,
  };
}

function harness(rows: Row[]) {
  const db = new MemoryPrisma();
  db.now = () => NOW;
  db.tables.publishTarget.push(...rows);
  const dispatched: { targetId: string; attemptNo: number }[] = [];
  const reconciles: { targetId: string; checkNo: number }[] = [];
  const queue = {
    dispatch: async (input: { targetId: string; attemptNo: number }) => {
      dispatched.push({ targetId: input.targetId, attemptNo: input.attemptNo });
      return true;
    },
    reconcile: async (input: { targetId: string; checkNo: number }) => {
      reconciles.push({ targetId: input.targetId, checkNo: input.checkNo });
      return true;
    },
  } as unknown as PublishQueue;
  const handled: unknown[] = [];
  const dispatcher = {
    dispatch: async (payload: unknown) => {
      handled.push(payload);
      return "submitted";
    },
    reconcile: async (payload: unknown) => {
      handled.push(payload);
      return "waiting";
    },
  } as unknown as PublishDispatcher;
  const worker = new PublishWorker(
    db as unknown as PrismaService,
    {} as RedisService,
    queue,
    dispatcher,
    { configured: true } as PostizClient,
  );
  return { db, worker, dispatched, reconciles, handled };
}

describe("PublishWorker watchdog", () => {
  it("enqueues confirmed posts whose job was lost, but not ones just confirmed or still waiting", async () => {
    const { worker, dispatched } = harness([
      target("01JCT00000000000000000000A"),
      target("01JCT00000000000000000000B", { updatedAt: new Date(NOW - 5_000) }),
      target("01JCT00000000000000000000C", { retryAfter: new Date(NOW + 60_000) }),
      target("01JCT00000000000000000000D", { retryAfter: new Date(NOW - 1_000) }),
      // A claim abandoned by a process that died mid-upload.
      target("01JCT00000000000000000000E", {
        status: "validating",
        updatedAt: new Date(NOW - 31 * 60_000),
      }),
      target("01JCT00000000000000000000F", {
        status: "validating",
        updatedAt: new Date(NOW - 60_000),
      }),
    ]);
    await worker.sweepOnce(NOW);
    expect(dispatched.map((job) => job.targetId.slice(-1)).sort()).toEqual(["A", "D", "E"]);
  });

  it("gives a passing failure its next attempt when its wait is over, while attempts remain", async () => {
    const { db, worker, dispatched } = harness([
      target("01JCT00000000000000000000A", {
        status: "failed_retryable",
        retryAfter: new Date(NOW - 1),
        lastErrorCode: "publishing/provider_unavailable",
        lastErrorSafeMessage: "was down",
      }),
      target("01JCT00000000000000000000B", {
        status: "failed_retryable",
        retryAfter: new Date(NOW + 60_000),
      }),
      target("01JCT00000000000000000000C", {
        status: "failed_retryable",
        attemptNo: AUTO_ATTEMPTS,
        retryAfter: new Date(NOW - 1),
      }),
      // Refused by the platform: no wait, so no automatic retry.
      target("01JCT00000000000000000000D", { status: "failed_retryable", retryAfter: null }),
    ]);
    await worker.sweepOnce(NOW);
    expect(dispatched).toEqual([{ targetId: "01JCT00000000000000000000A", attemptNo: 2 }]);
    expect(db.tables.publishTarget[0]).toMatchObject({
      status: "ready",
      attemptNo: 2,
      retryAfter: null,
      lastErrorCode: null,
    });
    expect(db.tables.publishTarget[2]).toMatchObject({
      status: "failed_retryable",
      attemptNo: AUTO_ATTEMPTS,
    });
  });

  it("asks about posts handed over whose next look is due", async () => {
    const { worker, reconciles } = harness([
      target("01JCT00000000000000000000A", {
        status: "processing",
        checkNo: 2,
        nextCheckAt: new Date(NOW - 1),
      }),
      target("01JCT00000000000000000000B", {
        status: "scheduled",
        checkNo: 0,
        nextCheckAt: new Date(NOW + 1_000),
      }),
      target("01JCT00000000000000000000C", {
        status: "submitted",
        checkNo: 0,
        nextCheckAt: new Date(NOW),
      }),
      target("01JCT00000000000000000000D", { status: "published", nextCheckAt: null }),
    ]);
    await worker.sweepOnce(NOW);
    expect(reconciles).toEqual([
      { targetId: "01JCT00000000000000000000A", checkNo: 3 },
      { targetId: "01JCT00000000000000000000C", checkNo: 1 },
    ]);
  });
});

describe("PublishWorker jobs", () => {
  it("hands a valid payload, bare or in the contract envelope, to the dispatcher", async () => {
    const { worker, handled } = harness([]);
    const payload = {
      schemaVersion: 1,
      publishTargetId: "01JCT00000000000000000000A",
      attemptNo: 1,
    };
    await expect(worker.handleDispatch({ data: payload })).resolves.toBe("submitted");
    await expect(
      worker.handleReconcile({
        data: {
          jobId: "j",
          attemptId: "a",
          workspaceId: WS,
          priority: 1,
          jobKey: "publish.reconcile:01JCT00000000000000000000A:1",
          createdAt: new Date(NOW).toISOString(),
          payload: { schemaVersion: 1, publishTargetId: "01JCT00000000000000000000A", checkNo: 1 },
        },
      }),
    ).resolves.toBe("waiting");
    expect(handled).toHaveLength(2);
  });

  it("refuses a malformed job outright: retrying cannot fix a payload", async () => {
    const { worker } = harness([]);
    await expect(worker.handleDispatch({ data: { publishTargetId: "x" } })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    // Copy never rides in Redis: an extra field is refused, not ignored.
    await expect(
      worker.handleDispatch({
        data: {
          schemaVersion: 1,
          publishTargetId: "01JCT00000000000000000000A",
          attemptNo: 1,
          text: "hello",
        },
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("does not start without a Postiz key", () => {
    const db = new MemoryPrisma();
    const worker = new PublishWorker(
      db as unknown as PrismaService,
      {} as RedisService,
      {} as PublishQueue,
      {} as PublishDispatcher,
      { configured: false } as PostizClient,
    );
    // Would throw on the missing Redis client if it tried to start a Worker.
    expect(() => {
      worker.onApplicationBootstrap();
    }).not.toThrow();
  });
});

describe("PublishQueue", () => {
  it("keys each job by the contract's job key, with BullMQ's colon-free id, and never retries", async () => {
    const added: { name: string; data: unknown; options: Record<string, unknown> }[] = [];
    const registry = {
      queue: () => ({
        add: async (name: string, data: unknown, options: Record<string, unknown>) => {
          added.push({ name, data, options });
          return { id: options["jobId"] };
        },
      }),
    } as unknown as QueueRegistry;
    const queue = new PublishQueue(registry);
    await queue.dispatch({ targetId: "01JCT00000000000000000000A", attemptNo: 2, workspaceId: WS });
    await queue.reconcile({ targetId: "01JCT00000000000000000000A", checkNo: 4, workspaceId: WS });
    expect(added[0]).toMatchObject({
      name: "publish.dispatch",
      options: {
        jobId: "publish.dispatch-01JCT00000000000000000000A-2",
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
      data: {
        workspaceId: WS,
        jobKey: "publish.dispatch:01JCT00000000000000000000A:2",
        payload: { schemaVersion: 1, publishTargetId: "01JCT00000000000000000000A", attemptNo: 2 },
      },
    });
    expect(added[1]?.options["jobId"]).toBe("publish.reconcile-01JCT00000000000000000000A-4");
    expect(bullIdOf("a:b:c")).toBe("a-b-c");
  });

  it("does not throw when Redis refuses: the watchdog enqueues it later", async () => {
    const registry = {
      queue: () => ({
        add: async () => {
          throw new Error("Redis is down");
        },
      }),
    } as unknown as QueueRegistry;
    await expect(
      new PublishQueue(registry).dispatch({
        targetId: "01JCT00000000000000000000A",
        attemptNo: 1,
        workspaceId: WS,
      }),
    ).resolves.toBe(false);
  });
});
