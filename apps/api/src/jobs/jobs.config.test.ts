import { describe, expect, it } from "vitest";

import { QUEUE_NAMES } from "./contracts/queue-names.js";
import {
  DEFAULT_QUEUE_POLICY,
  FREE_TIER_DAILY_MINUTES,
  JOB_EVENT_RETENTION_DAYS,
  PLAN_CONCURRENCY_LANE,
  PLAN_ENQUEUED_CAP_TENTHS,
  PLAN_KEYS,
  PLAN_MAX_QUEUE_WAIT_MS,
  PLAN_PRIORITY,
  planLimits,
  queuePrefix,
  heartbeatIntervalMs,
  queuePolicyFor,
} from "./jobs.config.js";

describe("plan tables", () => {
  it("cover every plan in the ladder", () => {
    for (const plan of PLAN_KEYS) {
      expect(PLAN_PRIORITY[plan]).toBeTypeOf("number");
      expect(PLAN_MAX_QUEUE_WAIT_MS[plan]).toBeTypeOf("number");
      expect(PLAN_ENQUEUED_CAP_TENTHS[plan]).toBeTypeOf("number");
      expect(PLAN_CONCURRENCY_LANE[plan]).toBeTypeOf("number");
    }
  });

  it("never uses BullMQ priority 0, which means 'last', not 'first'", () => {
    for (const plan of PLAN_KEYS) expect(PLAN_PRIORITY[plan]).toBeGreaterThan(0);
  });

  it("gets strictly better the further up the ladder", () => {
    for (let index = 1; index < PLAN_KEYS.length; index += 1) {
      const lower = PLAN_KEYS[index - 1] as (typeof PLAN_KEYS)[number];
      const higher = PLAN_KEYS[index] as (typeof PLAN_KEYS)[number];
      expect(PLAN_PRIORITY[higher]).toBeLessThan(PLAN_PRIORITY[lower]);
      expect(PLAN_MAX_QUEUE_WAIT_MS[higher]).toBeLessThan(PLAN_MAX_QUEUE_WAIT_MS[lower]);
      expect(PLAN_ENQUEUED_CAP_TENTHS[higher]).toBeGreaterThan(PLAN_ENQUEUED_CAP_TENTHS[lower]);
      expect(PLAN_CONCURRENCY_LANE[higher]).toBeGreaterThan(PLAN_CONCURRENCY_LANE[lower]);
    }
  });

  it("bundles the four numbers a producer needs", () => {
    expect(planLimits("creator")).toEqual({
      plan: "creator",
      priority: PLAN_PRIORITY.creator,
      maxQueueWaitMs: PLAN_MAX_QUEUE_WAIT_MS.creator,
      enqueuedCapTenths: PLAN_ENQUEUED_CAP_TENTHS.creator,
      concurrencyLane: PLAN_CONCURRENCY_LANE.creator,
    });
  });

  it("keeps the free-tier allowance and the retention window sane", () => {
    expect(FREE_TIER_DAILY_MINUTES).toBeGreaterThan(0);
    expect(JOB_EVENT_RETENTION_DAYS).toBe(30);
  });
});

describe("queuePolicyFor", () => {
  it("picks the attempts of the A08b brief, by queue family", () => {
    expect(queuePolicyFor("media.probe").attempts).toBe(3);
    expect(queuePolicyFor("ai.transcribe").attempts).toBe(2);
    expect(queuePolicyFor("render.video").attempts).toBe(2);
    expect(queuePolicyFor("notify").attempts).toBe(5);
  });

  it("falls back for a family it has never heard of", () => {
    expect(queuePolicyFor("something.else")).toEqual(DEFAULT_QUEUE_POLICY);
  });

  it("jitters every backoff, so an outage does not retry as one thundering herd", () => {
    for (const queue of QUEUE_NAMES) {
      const policy = queuePolicyFor(queue);
      expect(policy.backoffJitter, queue).toBeGreaterThan(0);
      expect(policy.backoffJitter, queue).toBeLessThanOrEqual(1);
    }
  });

  it("gives the long ASR queues a ten-minute lock", () => {
    expect(queuePolicyFor("ai.transcribe").lockDurationMs).toBe(600_000);
    expect(queuePolicyFor("ai.diarise").lockDurationMs).toBe(600_000);
    // and leaves the short ones on the family default
    expect(queuePolicyFor("ai.clean").lockDurationMs).toBe(120_000);
  });

  it("never lets the stall check run less often than the lock it guards", () => {
    for (const queue of QUEUE_NAMES) {
      const policy = queuePolicyFor(queue);
      expect(policy.stalledIntervalMs, queue).toBeLessThan(policy.lockDurationMs);
      expect(policy.maxStalledCount, queue).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("heartbeatIntervalMs", () => {
  it("is a third of the lock, so two missed beats still leave it alive", () => {
    for (const queue of QUEUE_NAMES) {
      const policy = queuePolicyFor(queue);
      expect(heartbeatIntervalMs(queue), queue).toBe(Math.floor(policy.lockDurationMs / 3));
      expect(heartbeatIntervalMs(queue) * 2, queue).toBeLessThan(policy.lockDurationMs);
    }
  });
});

describe("queuePrefix", () => {
  it("defaults to BullMQ's own prefix, which is what the workers use", () => {
    expect(queuePrefix({})).toBe("bull");
    expect(queuePrefix({ MONTAJ_QUEUE_PREFIX: "" })).toBe("bull");
    expect(queuePrefix({ MONTAJ_QUEUE_PREFIX: "   " })).toBe("bull");
  });

  it("is overridable so a shared Redis can be partitioned", () => {
    expect(queuePrefix({ MONTAJ_QUEUE_PREFIX: "a08" })).toBe("a08");
  });
});
