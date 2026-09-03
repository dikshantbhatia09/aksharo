/**
 * The A08b retry/stall table must not drift from the TypeScript source.
 *
 * `apps/api/src/jobs/jobs.config.ts` owns it. `attempts` and `backoff` reach a
 * worker inside the BullMQ job options, but `lockDurationMs`,
 * `stalledIntervalMs` and `maxStalledCount` are `Worker` **constructor** options
 * and have to be read from that table by each worker package — so a drift here
 * is not a compile error anywhere, it is a ten-minute render declared stalled at
 * five minutes and handed to a second worker while the first is still encoding.
 *
 * This parses the TypeScript, the same way `apps/worker-ai/tests/test_policies.py`
 * does for the Python copy.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  heartbeatIntervalMs,
  queuePolicyFor,
  RENDER_QUEUE_OVERRIDES,
  RENDER_QUEUE_POLICY,
  workerOptions,
} from "./policies.js";
import { RENDER_SUBTITLE_QUEUE, RENDER_VIDEO_QUEUE } from "./queues.js";

const JOBS_CONFIG = join(
  __dirname,
  "..",
  "..",
  "..",
  "apps",
  "api",
  "src",
  "jobs",
  "jobs.config.ts",
);

function source(): string {
  return readFileSync(JOBS_CONFIG, "utf8");
}

/** Pulls `render: { … }` out of `QUEUE_POLICY_BY_FAMILY`. */
function renderFamilyBlock(text: string): string {
  const start = text.indexOf("QUEUE_POLICY_BY_FAMILY");
  expect(start).toBeGreaterThan(-1);
  const renderAt = text.indexOf("render: {", start);
  expect(renderAt).toBeGreaterThan(-1);
  return text.slice(renderAt, text.indexOf("},", renderAt));
}

function numberField(block: string, field: string): number {
  // eslint-disable-next-line security/detect-non-literal-regexp -- RegExp built from a fixed/internal string (test fixture or bounded value, not attacker input) -- reviewed for M06's eslint-plugin-security promotion
  const match = new RegExp(`${field}:\\s*([0-9_.]+)`).exec(block);
  expect(match?.[1], `${field} is missing from the API's table`).toBeDefined();
  return Number((match?.[1] ?? "").replace(/_/g, ""));
}

describe("the render family policy", () => {
  it("matches the API's table field for field", () => {
    const block = renderFamilyBlock(source());
    expect(numberField(block, "attempts")).toBe(RENDER_QUEUE_POLICY.attempts);
    expect(numberField(block, "backoffMs")).toBe(RENDER_QUEUE_POLICY.backoffMs);
    expect(numberField(block, "backoffJitter")).toBe(RENDER_QUEUE_POLICY.backoffJitter);
    expect(numberField(block, "lockDurationMs")).toBe(RENDER_QUEUE_POLICY.lockDurationMs);
    expect(numberField(block, "stalledIntervalMs")).toBe(RENDER_QUEUE_POLICY.stalledIntervalMs);
    expect(numberField(block, "maxStalledCount")).toBe(RENDER_QUEUE_POLICY.maxStalledCount);
  });

  it("matches the API's per-queue override for render.video", () => {
    const text = source();
    const start = text.indexOf("QUEUE_POLICY_OVERRIDES");
    const line = text.slice(text.indexOf('"render.video":', start));
    const block = line.slice(0, line.indexOf("}"));
    const override = RENDER_QUEUE_OVERRIDES["render.video"];
    expect(override).toBeDefined();
    expect(numberField(block, "lockDurationMs")).toBe(override?.lockDurationMs);
    expect(numberField(block, "stalledIntervalMs")).toBe(override?.stalledIntervalMs);
  });

  it("gives render.video a longer lock than render.subtitle", () => {
    // A 4K export of a long timeline genuinely takes ten minutes; a sidecar is
    // text, so a shorter lock only means a dead worker is noticed sooner.
    expect(queuePolicyFor(RENDER_VIDEO_QUEUE).lockDurationMs).toBe(600_000);
    expect(queuePolicyFor(RENDER_SUBTITLE_QUEUE).lockDurationMs).toBe(300_000);
  });

  it("falls back to the family policy for a queue with no override", () => {
    expect(queuePolicyFor("render.something-else")).toEqual(RENDER_QUEUE_POLICY);
  });

  it("beats three times inside each lock", () => {
    // Two consecutive missed beats still leave the lock alive.
    expect(heartbeatIntervalMs(RENDER_VIDEO_QUEUE)).toBe(200_000);
    expect(heartbeatIntervalMs(RENDER_SUBTITLE_QUEUE)).toBe(100_000);
    for (const queue of [RENDER_VIDEO_QUEUE, RENDER_SUBTITLE_QUEUE]) {
      expect(heartbeatIntervalMs(queue) * 3).toBeLessThanOrEqual(
        queuePolicyFor(queue).lockDurationMs,
      );
    }
  });

  it("produces the three BullMQ Worker options", () => {
    expect(workerOptions(RENDER_VIDEO_QUEUE)).toEqual({
      lockDuration: 600_000,
      stalledInterval: 60_000,
      maxStalledCount: 1,
    });
  });
});
