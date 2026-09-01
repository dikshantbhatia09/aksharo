import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETRY_POLICY,
  FREE_TIER_DAILY_MINUTES,
  JOB_EVENT_RETENTION_DAYS,
  PLAN_CONCURRENCY_LANE,
  PLAN_ENQUEUED_CAP_TENTHS,
  PLAN_KEYS,
  PLAN_MAX_QUEUE_WAIT_MS,
  PLAN_PRIORITY,
  planLimits,
  queuePrefix,
  retryPolicyFor,
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

describe("retryPolicyFor", () => {
  it("picks the policy by queue family", () => {
    expect(retryPolicyFor("media.probe").attempts).toBe(3);
    expect(retryPolicyFor("ai.transcribe").attempts).toBe(2);
    expect(retryPolicyFor("render.video").attempts).toBe(2);
    expect(retryPolicyFor("notify").attempts).toBe(5);
  });

  it("falls back for a family it has never heard of", () => {
    expect(retryPolicyFor("something.else")).toEqual(DEFAULT_RETRY_POLICY);
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
