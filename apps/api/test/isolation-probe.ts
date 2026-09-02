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
 *   3. write the SAME hard-coded Redis key (`montaj:auth:…`, the shape the product
 *      really uses) with different values, and read their own value back. On a
 *      shared logical database the last writer wins and one of them reads the
 *      other's.
 *
 * The rendezvous in `isolation-barrier.ts` is what makes the overlap real rather
 * than hoped for.
 */
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { rendezvous } from "./isolation-barrier.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { suiteQueuePrefix, suiteRedisDb, testRun } from "./suite-context.js";

import type { TestDatabase } from "./db-harness.js";

/** Deliberately identical in both halves: the collision is the point. */
const SHARED_USER_ID = "01JISOLATION0000000000000A";
const SHARED_EMAIL = "isolation-probe@example.test";
/** A key the product itself would write, prefix and all (`auth.constants.ts`). */
const SHARED_REDIS_KEY = "montaj:auth:isolation-probe";

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
      await db?.stop();
    }, 60_000);

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
    });

    it("accepts the same primary key both suites insert at the same instant", async () => {
      await db.prisma.user.create({
        data: { id: SHARED_USER_ID, email: SHARED_EMAIL, name: party },
      });
      await rendezvous(runId, "user-inserted", party);

      const rows = await db.prisma.user.findMany({ where: { id: SHARED_USER_ID } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe(party);
    });

    it("survives the other suite truncating the same table", async () => {
      if (party === TRUNCATING_PARTY) {
        await db.prisma.$executeRawUnsafe("TRUNCATE TABLE users CASCADE");
      }
      // The truncating half publishes its marker only after the TRUNCATE, so
      // everybody past this line knows it has already happened.
      await rendezvous(runId, "user-truncated", party);

      const survivors = await db.prisma.user.count({ where: { id: SHARED_USER_ID } });
      expect(survivors).toBe(party === TRUNCATING_PARTY ? 0 : 1);
    });

    it.skipIf(!redisReady)("owns its logical Redis database and its queue prefix", async () => {
      const client = redis;
      if (client === undefined) throw new Error("redis client missing");

      const logicalDb = String(suiteRedisDb() ?? -1);
      await client.set(SHARED_REDIS_KEY, party);
      const met = await rendezvous(runId, "redis-written", party, logicalDb);

      expect(await client.get(SHARED_REDIS_KEY)).toBe(party);
      for (const [other, otherDb] of Object.entries(met.parties)) {
        if (other === party) continue;
        expect(otherDb).not.toBe(logicalDb);
      }

      // BullMQ keys and realtime channels are separated by the prefix instead:
      // Redis pub/sub ignores the logical database entirely.
      expect(process.env["MONTAJ_QUEUE_PREFIX"]).toBe(suiteQueuePrefix());
      const prefixes = await rendezvous(runId, "queue-prefix", party, suiteQueuePrefix());
      for (const [other, otherPrefix] of Object.entries(prefixes.parties)) {
        if (other === party) continue;
        expect(otherPrefix).not.toBe(suiteQueuePrefix());
      }
    });
  });
}
