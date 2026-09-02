/**
 * The worker half of A23a: which corner of the run's infrastructure *this* spec
 * file owns.
 *
 * Every value here is derived from two facts a Vitest worker can always see: the
 * run description `test/global-setup.ts` published through `provide()`, and the
 * path of the spec file being executed. Nothing is negotiated between workers, so
 * the answers are the same whether the file runs alone or alongside thirteen
 * others — which is what makes a parallel failure reproducible with a single
 * `vitest run test/<file>`.
 *
 * `test/setup-env.ts` calls {@link applySuiteEnvironment} before the module graph
 * is loaded, so `MONTAJ_QUEUE_PREFIX` and `REDIS_URL` are already the suite's own
 * by the time a spec reads them at collection time.
 */
import { basename } from "node:path";

import { expect, inject } from "vitest";

import {
  fallbackSlot,
  queuePrefixForSlot,
  redisDbForSlot,
  redisUrlForSlot,
  type TestRunInfo,
} from "./test-run.js";

let cachedRun: TestRunInfo | null | undefined;

/**
 * The run description, or `null` when this process was not started by our
 * `globalSetup` (a bare `vitest run -c some-other.config.ts`, for instance).
 * Returning `null` rather than throwing keeps that case on the skip path.
 */
export function testRun(): TestRunInfo | null {
  if (cachedRun !== undefined) return cachedRun;
  try {
    cachedRun = (inject("montajTestRun") as TestRunInfo | undefined) ?? null;
  } catch {
    cachedRun = null;
  }
  return cachedRun;
}

/** `…/test/auth.e2e-spec.ts` -> `auth.e2e-spec`. */
export function suiteName(): string {
  const state = expect.getState() as { testPath?: string };
  const path = state.testPath;
  if (path === undefined || path === "") return "unknown-suite";
  return basename(path).replace(/\.[cm]?[jt]sx?$/, "");
}

/**
 * This suite's slot: its index in the run, and the seed of every name it owns.
 *
 * A file the global setup did not enumerate — a unit test under `src/`, or a spec
 * run under some other config — lands on a hashed slot placed ABOVE every assigned
 * one, so it can never be handed the logical Redis database or the queue prefix
 * that belongs to a real e2e suite.
 */
export function suiteSlot(): number {
  const name = suiteName();
  const run = testRun();
  if (run === null) return fallbackSlot(name);
  return run.slots[name] ?? Object.keys(run.slots).length + fallbackSlot(name);
}

/** The BullMQ / realtime key prefix this suite owns. */
export function suiteQueuePrefix(): string {
  const run = testRun();
  if (run === null) return `montaj-test-${String(process.pid)}`;
  return queuePrefixForSlot(run.runId, suiteSlot());
}

/** The Redis URL this suite owns — the run's server, the suite's logical database. */
export function suiteRedisUrl(): string | null {
  const run = testRun();
  if (run?.redis == null) return null;
  return redisUrlForSlot(run.redis, suiteSlot());
}

/** The logical Redis database this suite owns, for the console line. */
export function suiteRedisDb(): number | null {
  const run = testRun();
  if (run?.redis == null) return null;
  return redisDbForSlot(run.redis, suiteSlot());
}

/**
 * Point this worker's environment at the suite's own corner.
 *
 * Called from `setup-env.ts`, which runs before the spec module is evaluated, so
 * the module-scope `process.env["MONTAJ_QUEUE_PREFIX"]` reads in `jobs.e2e-spec`
 * and `dlq.e2e-spec` see the suite's prefix rather than a default. Assigned rather
 * than defaulted (`??=`): an inherited `REDIS_URL` pointing at a developer's own
 * stack is exactly what the isolation exists to override.
 */
export function applySuiteEnvironment(): void {
  process.env["MONTAJ_QUEUE_PREFIX"] = suiteQueuePrefix();
  // A23b: the same name for the keys the product writes under `montaj:` — the
  // dev outbox, the rate-limit buckets, the entitlement cache, the suppression
  // list, the export bundles. Redis ships with sixteen logical databases and this
  // package has more e2e suites than that, so the prefix — not the database — is
  // what keeps two suites out of each other's keys.
  process.env["MONTAJ_REDIS_PREFIX"] = suiteQueuePrefix();
  const redisUrl = suiteRedisUrl();
  if (redisUrl !== null) process.env["REDIS_URL"] = redisUrl;
}
