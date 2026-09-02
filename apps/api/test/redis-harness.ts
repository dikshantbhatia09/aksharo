/**
 * The Redis one integration suite may use.
 *
 * Since A23a there is exactly ONE Redis per Vitest run — `test/global-setup.ts`
 * either reuses `TEST_REDIS_URL` or starts a single `redis:7-alpine` container —
 * and each suite is given a slice of it:
 *
 *   * its own **logical database** (`redis://host:6379/<n>`), which is what keeps
 *     the keys the product hard-codes (`montaj:auth:*`, `montaj:rl:*`) belonging
 *     to one suite even though two suites write the same key names;
 *   * its own **`MONTAJ_QUEUE_PREFIX`**, which is what keeps BullMQ structures and
 *     realtime pub/sub channels apart — pub/sub is not scoped by the logical
 *     database, so the prefix is the only isolation there.
 *
 * `test/setup-env.ts` puts both into the environment before the spec module is
 * evaluated, so a suite that reads `process.env["MONTAJ_QUEUE_PREFIX"]` at
 * collection time already sees its own.
 *
 * `MONTAJ_SKIP_REDIS_TESTS=1` skips deliberately.
 */
import { suiteRedisUrl, testRun } from "./suite-context.js";

/** Why the suite was skipped, for the console message. */
export let redisSkipReason = "";

/**
 * The URL this suite should connect to.
 *
 * Falls back to the plain environment only when `global-setup.ts` did not run, so
 * a spec executed under some other Vitest config still has something to dial.
 */
export function testRedisUrl(): string {
  return (
    suiteRedisUrl() ??
    process.env["TEST_REDIS_URL"] ??
    process.env["REDIS_URL"] ??
    "redis://localhost:6379"
  );
}

/**
 * Is a Redis reachable for this suite?
 *
 * Answered SYNCHRONOUSLY for the same reason `db-harness.ts` is: `describe.skipIf`
 * is evaluated while the file is collected, and this package compiles to CommonJS,
 * so there is no top-level await to hide an async probe behind. Before A23a that
 * meant a TCP probe in a child process per suite; the run-level setup has already
 * connected and pinged, so this is now a property read.
 */
export function isRedisAvailable(): boolean {
  const run = testRun();
  if (run === null) {
    redisSkipReason = "vitest globalSetup did not run (test/global-setup.ts)";
    return false;
  }
  if (run.redis === null) {
    redisSkipReason = run.redisSkipReason;
    return false;
  }
  redisSkipReason = "";
  return true;
}
