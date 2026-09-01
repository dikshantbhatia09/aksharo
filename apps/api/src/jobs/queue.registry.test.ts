import { describe, expect, it } from "vitest";

import { queuePolicyFor } from "./jobs.config.js";
import { QueueRegistry, bullJobId } from "./queue.registry.js";
import { createFakeRedis } from "../../test/fakes.js";

import type { RedisService } from "../common/redis/redis.service.js";

function registry(): QueueRegistry {
  return new QueueRegistry(createFakeRedis() as unknown as RedisService);
}

describe("bullJobId", () => {
  it("joins the job and attempt with a dash, because BullMQ forbids a colon", () => {
    expect(bullJobId("01JCJOB0000000000000000000", "01JCATT0000000000000000000")).toBe(
      "01JCJOB0000000000000000000-01JCATT0000000000000000000",
    );
    expect(bullJobId("a", "b")).not.toContain(":");
  });
});

describe("optionsFor", () => {
  it("derives the BullMQ id from the row, so a replay needs no second identifier", () => {
    const options = registry().optionsFor({
      queueName: "ai.transcribe",
      jobId: "01JCJOB0000000000000000000",
      attemptId: "01JCATT0000000000000000000",
      priority: 3,
    });
    expect(options.jobId).toBe("01JCJOB0000000000000000000-01JCATT0000000000000000000");
    expect(options.priority).toBe(3);
  });

  it("takes attempts and jittered backoff from the queue's policy", () => {
    const registryInstance = registry();
    for (const queueName of ["media.probe", "ai.transcribe", "render.video", "notify"] as const) {
      const options = registryInstance.optionsFor({
        queueName,
        jobId: "j",
        attemptId: "a",
        priority: 1,
      });
      const policy = queuePolicyFor(queueName);
      expect(options.attempts, queueName).toBe(policy.attempts);
      expect(options.backoff, queueName).toEqual({
        type: "exponential",
        delay: policy.backoffMs,
        jitter: policy.backoffJitter,
      });
    }
  });

  it("keeps only a recent tail in Redis: the jobs table is the record", () => {
    const options = registry().optionsFor({
      queueName: "notify",
      jobId: "j",
      attemptId: "a",
      priority: 5,
    });
    expect(options.removeOnComplete).toEqual({ age: 3_600, count: 1_000 });
    // Failures live longer, because A08b's dead-letter copy reads them.
    expect(options.removeOnFail).toEqual({ age: 604_800, count: 5_000 });
  });
});

describe("prefix", () => {
  it("defaults to BullMQ's own prefix so the workers find the queues", () => {
    const previous = process.env["MONTAJ_QUEUE_PREFIX"];
    delete process.env["MONTAJ_QUEUE_PREFIX"];
    try {
      expect(registry().prefix).toBe("bull");
    } finally {
      if (previous !== undefined) process.env["MONTAJ_QUEUE_PREFIX"] = previous;
    }
  });
});
