import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUEUE_POLICY,
  QUEUE_POLICY_BY_FAMILY,
  QUEUE_POLICY_OVERRIDES,
  heartbeatIntervalMs,
  queuePolicyFor,
  workerOptions,
} from "./policies.js";
import { MEDIA_QUEUES, QUEUE_NAMES } from "./queues.js";

/**
 * The A08b retry/stall policy must not drift from the TypeScript source.
 *
 * `apps/api/src/jobs/jobs.config.ts` is the source of truth. A drift here is not a
 * compile error anywhere: it is a job silently declared stalled and handed to a
 * second worker while the first is still encoding it. This file parses the source
 * the same way `apps/worker-ai/tests/test_policies.py` does for the Python side.
 */
const JOBS_CONFIG = resolve(__dirname, "../../api/src/jobs/jobs.config.ts");

const FIELDS = [
  "attempts",
  "backoffMs",
  "backoffJitter",
  "lockDurationMs",
  "stalledIntervalMs",
  "maxStalledCount",
] as const;

function source(): string {
  return readFileSync(JOBS_CONFIG, "utf8");
}

/** The brace-matched object literal that follows `marker`. */
function objectAfter(text: string, marker: string): string {
  const at = text.indexOf(marker);
  expect(at, `could not find ${marker} in jobs.config.ts`).toBeGreaterThanOrEqual(0);
  const tail = text.slice(text.indexOf("{", at));
  let depth = 0;
  for (let index = 0; index < tail.length; index += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    if (tail[index] === "{") depth += 1;
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    else if (tail[index] === "}") {
      depth -= 1;
      if (depth === 0) return tail.slice(0, index + 1);
    }
  }
  throw new Error("unbalanced braces in jobs.config.ts");
}

/** Every `key: 1_234` or `key: 0.3` in a TypeScript object literal. */
function numbers(block: string): Record<string, number> {
  const found: Record<string, number> = {};
  // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
  for (const [, key, value] of block.matchAll(/(\w+):\s*([0-9_]+(?:\.[0-9]+)?)\s*,/g)) {
    if ((FIELDS as readonly string[]).includes(key ?? "")) {
      found[key as string] = Number((value ?? "").replace(/_/g, ""));
    }
  }
  return found;
}

function asRecord(policy: object): Record<string, number> {
  const indexable = policy as Record<string, number>;
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  return Object.fromEntries(FIELDS.map((field) => [field, indexable[field]])) as Record<
    string,
    number
  >;
}

describe("policy table (mirrors apps/api/src/jobs/jobs.config.ts)", () => {
  it("matches the default policy", () => {
    const block = objectAfter(source(), "export const DEFAULT_QUEUE_POLICY");
    expect(numbers(block)).toEqual(asRecord(DEFAULT_QUEUE_POLICY));
  });

  it.each(["media", "ai", "render", "notify"])("matches the %s family", (family) => {
    const table = objectAfter(source(), "export const QUEUE_POLICY_BY_FAMILY");
    const block = objectAfter(table, `${family}:`);
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    expect(numbers(block)).toEqual(asRecord(QUEUE_POLICY_BY_FAMILY[family] ?? {}));
  });

  it("lists exactly the same families", () => {
    const table = objectAfter(source(), "export const QUEUE_POLICY_BY_FAMILY");
    const families = [...table.matchAll(/^ {2}(\w+):\s*\{/gm)].map((match) => match[1]);
    expect(families.sort()).toEqual(Object.keys(QUEUE_POLICY_BY_FAMILY).sort());
  });

  it("matches the per-queue overrides", () => {
    const table = objectAfter(source(), "export const QUEUE_POLICY_OVERRIDES");
    const fromApi: Record<string, Record<string, number>> = {};
    for (const [, queue, body] of table.matchAll(/"([\w.]+)":\s*\{([^}]*)\}/g)) {
      const entries: Record<string, number> = {};
      for (const [, key, value] of (body ?? "").matchAll(/(\w+):\s*([0-9_]+)/g)) {
        entries[key as string] = Number((value ?? "").replace(/_/g, ""));
      }
      fromApi[queue as string] = entries;
    }
    expect(fromApi).toEqual(QUEUE_POLICY_OVERRIDES);
  });

  it("keeps the heartbeat at a third of the lock in both files", () => {
    expect(source()).toContain("lockDurationMs / 3");
    for (const queue of QUEUE_NAMES) {
      expect(heartbeatIntervalMs(queue), queue).toBe(
        Math.floor(queuePolicyFor(queue).lockDurationMs / 3),
      );
    }
  });
});

describe("the resolved media policies", () => {
  it("gives both media queues a ten-minute lock and three attempts", () => {
    for (const queue of MEDIA_QUEUES) {
      const policy = queuePolicyFor(queue);
      expect(policy.lockDurationMs, queue).toBe(600_000);
      expect(policy.stalledIntervalMs, queue).toBe(60_000);
      expect(policy.attempts, queue).toBe(3);
      expect(policy.maxStalledCount, queue).toBe(1);
    }
  });

  it("falls back to the default for a family it has never heard of", () => {
    expect(queuePolicyFor("mystery.queue")).toEqual(DEFAULT_QUEUE_POLICY);
    expect(queuePolicyFor("mystery")).toEqual(DEFAULT_QUEUE_POLICY);
  });
});

describe("workerOptions", () => {
  it("carries the policy to BullMQ", () => {
    expect(workerOptions("media.proxy", { concurrency: 4, prefix: "a07" })).toEqual({
      concurrency: 4,
      prefix: "a07",
      lockDuration: 600_000,
      lockRenewTime: 200_000,
      stalledInterval: 60_000,
      maxStalledCount: 1,
    });
  });

  it("renews the lock on the heartbeat's cadence, so two missed beats still hold it", () => {
    for (const queue of MEDIA_QUEUES) {
      const options = workerOptions(queue, { concurrency: 1, prefix: "bull" });
      expect(options.lockRenewTime).toBe(heartbeatIntervalMs(queue));
      expect(options.lockRenewTime * 3).toBeLessThanOrEqual(options.lockDuration);
    }
  });
});
