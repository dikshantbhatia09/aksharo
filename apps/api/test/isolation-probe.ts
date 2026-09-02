/**
 * The deliberate collision test for A23a, shared by the two halves of the pair.
 *
 * `isolation-alpha.e2e-spec.ts` and `isolation-beta.e2e-spec.ts` both call
 * {@link isolationProbe}. Vitest runs them in parallel, in separate processes, and
 * they then do the three things that used to break a run where two suites shared a
 * database (A05 and A12 both reported it):
 *
 *   1. insert the SAME primary key into the SAME table at the same instant. On a
 *      shared database one of them gets a unique-violation.
 *   2. one of them `TRUNCATE`s that table while the other holds a row in it. On a
 *      shared database the other's row disappears — the exact failure the
 *      `TEST_DATABASE_URL` hazard note used to warn about.
 *   3. write the SAME product Redis key — `redisKeys.devOutbox()`, the one A21
 *      watched `auth.e2e-spec.ts` lose messages from — with different values, and
 *      read their own back.
 *
 * A23b added a fourth, and it is the one that matters now that the package has
 * more e2e suites than Redis has logical databases:
 *
 *   4. do (3) again with both halves pinned to the SAME logical Redis database,
 *      then have one of them run the `KEYS <prefix>:*` + `DEL` sweep a suite does
 *      between tests, and prove the other's key is still there. Nothing but the
 *      per-suite key prefix separates them, which is exactly the claim.
 *
 * The rendezvous in `isolation-barrier.ts` is what makes the overlap real rather
 * than hoped for.
 */
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { rendezvous } from "./isolation-barrier.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { suiteQueuePrefix, testRun } from "./suite-context.js";
import { redisKeys } from "../src/auth/auth.constants.js";
import { redisKeyPrefix } from "../src/common/redis/redis-keys.js";

import type { TestDatabase } from "./db-harness.js";

/** Deliberately identical in both halves: the collision is the point. */
const SHARED_USER_ID = "01JISOLATION0000000000000A";
const SHARED_EMAIL = "isolation-probe@example.test";
/** The half that truncates. The other half proves its rows survived. */
const TRUNCATING_PARTY = "alpha";

export function isolationProbe(party: string): void {
  const dbReady = isDatabaseAvailable();
  const redisReady = isRedisAvailable();
  if (!dbReady) console.warn(`[isolation.${party}] skipped - ${skipReason}`);
  else if (!redisReady)
    console.warn(`[isolation.${party}] redis half skipped - ${redisSkipReason}`);

  describe.skipIf(!dbReady)(`suite isolation (${party})`, () => {
    let db: TestDatabase;
    let redis: IORedis | undefined;
    /** Pinned to a logical database both halves share; see the last test. */
    let sharedDbRedis: IORedis | undefined;
    let runId = "";

    beforeAll(async () => {
      runId = testRun()?.runId ?? "no-run";
      const created = await createTestDatabase();
      if (created === null) throw new Error(`isolation probe has no database: ${skipReason}`);
      db = created;
      if (redisReady) redis = new IORedis(testRedisUrl(), { maxRetriesPerRequest: null });
    }, 120_000);

    afterAll(async () => {
      redis?.disconnect();
      sharedDbRedis?.disconnect();
      await db?.stop();
    }, 60_000);

    // Every `it` below that calls `rendezvous` is given a timeout comfortably
    // above that call's own (default 30s) budget. `rendezvous` is documented to
    // make a timeout "not a failure" — the assertions after it still run, against
    // fewer confirmed parties — but that is only true if the surrounding test
    // outlives it. Vitest's global `testTimeout` (30s, `vitest.config.ts`) is
    // exactly `rendezvous`'s own default, so with no override here Vitest killed
    // the test itself a hair before `rendezvous` could return gracefully, turning
    // "the sibling never arrived" into a hard timeout failure instead of the
    // proves-less-but-still-green result the design intends.

    it("runs against a database of its own, named for this run and this suite", async () => {
      const rows = await db.prisma.$queryRawUnsafe<{ name: string }[]>(
        "SELECT current_database() AS name",
      );
      const name = rows[0]?.name ?? "";
      expect(name).toContain(`montaj_t_${runId}`);

      const met = await rendezvous(runId, "database-name", party, name);
      for (const [other, otherName] of Object.entries(met.parties)) {
        if (other === party) continue;
        expect(otherName).not.toBe(name);
      }
    }, 40_000);

    it("accepts the same primary key both suites insert at the same instant", async () => {
      await db.prisma.user.create({
        data: { id: SHARED_USER_ID, email: SHARED_EMAIL, name: party },
      });
      await rendezvous(runId, "user-inserted", party);

      const rows = await db.prisma.user.findMany({ where: { id: SHARED_USER_ID } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe(party);
    }, 40_000);

    it("survives the other suite truncating the same table", async () => {
      if (party === TRUNCATING_PARTY) {
        await db.prisma.$executeRawUnsafe("TRUNCATE TABLE users CASCADE");
      }
      // The truncating half publishes its marker only after the TRUNCATE, so
      // everybody past this line knows it has already happened.
      await rendezvous(runId, "user-truncated", party);

      const survivors = await db.prisma.user.count({ where: { id: SHARED_USER_ID } });
      expect(survivors).toBe(party === TRUNCATING_PARTY ? 0 : 1);
    }, 40_000);

    // Two sequential rendezvous calls, so the worst case (neither arrives at
    // either barrier) is up to twice the single-barrier budget.
    it.skipIf(!redisReady)(
      "writes the product's own Redis keys under a namespace of its own",
      async () => {
        const client = redis;
        if (client === undefined) throw new Error("redis client missing");

        // The real key, from the real builder. Before A23b this evaluated to the
        // literal `montaj:auth:dev-outbox` for every suite in the run.
        const key = redisKeys.devOutbox();
        expect(key).toContain(redisKeyPrefix());
        await client.set(key, party);
        const met = await rendezvous(runId, "redis-written", party, key);

        expect(await client.get(key)).toBe(party);
        for (const [other, otherKey] of Object.entries(met.parties)) {
          if (other === party) continue;
          expect(otherKey).not.toBe(key);
        }

        // BullMQ keys and realtime channels are separated by their own prefix,
        // because Redis pub/sub ignores the logical database entirely.
        expect(process.env["MONTAJ_QUEUE_PREFIX"]).toBe(suiteQueuePrefix());
        const prefixes = await rendezvous(runId, "queue-prefix", party, suiteQueuePrefix());
        for (const [other, otherPrefix] of Object.entries(prefixes.parties)) {
          if (other === party) continue;
          expect(otherPrefix).not.toBe(suiteQueuePrefix());
        }
      },
      70_000,
    );

    /**
     * The A23b claim, tested head on.
     *
     * Both halves pin the SAME logical Redis database — the run's lowest, chosen
     * because both can compute it without talking to each other — so the logical
     * database provides no separation here at all. That is the situation a
     * twenty-two-suite package is permanently in against a Redis with sixteen
     * databases, and it is the situation A21 hit: `auth.e2e-spec.ts` lost its
     * dev-outbox messages to a sibling suite's between-tests sweep.
     */
    it.skipIf(!redisReady)(
      "keeps its keys when a suite on the SAME logical database sweeps its own",
      async () => {
        const info = testRun()?.redis;
        if (info == null) throw new Error("no redis in the run description");

        const url = new URL(info.baseUrl);
        url.pathname = `/${String(info.firstDb)}`;
        const shared = new IORedis(url.toString(), { maxRetriesPerRequest: null });
        sharedDbRedis = shared;

        const key = redisKeys.devOutbox();
        await shared.del(key);
        await shared.rpush(key, `${party}-message`);

        // The note carries the logical database as well as the key, so the
        // assertions can prove the two halves really are in the same one.
        const note = `${String(info.firstDb)}|${key}`;
        const met = await rendezvous(runId, "shared-db-written", party, note);
        for (const [other, otherNote] of Object.entries(met.parties)) {
          if (other === party) continue;
          const [otherDb, otherKey] = otherNote.split("|");
          expect(otherDb).toBe(String(info.firstDb));
          expect(otherKey).not.toBe(key);
        }

        // One half runs the sweep `auth-harness.reset()` runs between tests.
        if (party === TRUNCATING_PARTY) {
          const mine = await shared.keys(`${redisKeyPrefix()}:*`);
          expect(mine).toContain(key);
          if (mine.length > 0) await shared.del(...mine);
        }
        await rendezvous(runId, "shared-db-swept", party);

        // The sweeper lost its own message and nobody else's.
        expect(await shared.lrange(key, 0, -1)).toEqual(
          party === TRUNCATING_PARTY ? [] : [`${party}-message`],
        );
      },
      90_000,
    );
  });
}
