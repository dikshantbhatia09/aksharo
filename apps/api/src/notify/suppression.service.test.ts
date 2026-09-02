import { describe, expect, it } from "vitest";

import { notifyRedisKeys } from "./notify.constants.js";
import { SuppressionService } from "./suppression.service.js";
import { createFakePrisma, createMemoryRedis, FakeDb } from "../../test/fakes.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { RedisService } from "../common/redis/redis.service.js";

function build() {
  const redis = createMemoryRedis();
  const db = new FakeDb();
  const service = new SuppressionService(
    { client: redis } as unknown as RedisService,
    createFakePrisma(db) as unknown as PrismaService,
  );
  return { service, redis, db };
}

describe("the address hash", () => {
  it("is stable, case-insensitive and whitespace-insensitive", () => {
    const canonical = SuppressionService.hash("asha@example.test");
    expect(SuppressionService.hash("  ASHA@Example.Test ")).toBe(canonical);
    expect(SuppressionService.hash("other@example.test")).not.toBe(canonical);
    expect(canonical).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is what the Redis key is made of, so a dump is not a mailing list", async () => {
    const { service, redis } = build();
    await service.suppress({
      email: "asha@example.test",
      permanence: "permanent",
      reason: "Permanent/General",
      source: "ses-bounce",
    });
    const keys = [...redis.store.keys()];
    expect(keys).toEqual([
      notifyRedisKeys.suppression(SuppressionService.hash("asha@example.test")),
    ]);
    expect(keys.join(" ")).not.toContain("asha@example.test");
  });
});

describe("suppressing", () => {
  it("records the entry and writes a durable audit row with the address masked", async () => {
    const { service, db } = build();

    await service.suppress({
      email: "asha@example.test",
      permanence: "permanent",
      reason: "Permanent/General",
      source: "ses-bounce",
    });

    expect(await service.isSuppressed("asha@example.test")).toBe(true);
    // Case does not matter: the same mailbox is the same entry.
    expect(await service.isSuppressed("ASHA@example.test")).toBe(true);
    expect(await service.isSuppressed("someone@example.test")).toBe(false);

    expect(db.auditRows).toHaveLength(1);
    const row = db.auditRows[0];
    expect(row?.action).toBe("notify.address.suppressed");
    expect(row?.resource).toBe("email");
    expect(row?.actorKind).toBe("system");
    expect(row?.data).toMatchObject({
      email: "a***@example.test",
      permanence: "permanent",
      reason: "Permanent/General",
      source: "ses-bounce",
    });
  });

  it("keeps the reason and the timestamp on the entry", async () => {
    const { service } = build();
    await service.suppress({
      email: "full@example.test",
      permanence: "transient",
      reason: "Transient/MailboxFull",
      source: "ses-bounce",
    });
    const entry = await service.lookup("full@example.test");
    expect(entry).toMatchObject({ permanence: "transient", reason: "Transient/MailboxFull" });
    expect(Date.parse(entry?.at ?? "")).not.toBeNaN();
  });
});

describe("releasing", () => {
  it("lifts a transient entry when the mailbox delivers again", async () => {
    const { service } = build();
    await service.suppress({
      email: "full@example.test",
      permanence: "transient",
      reason: "Transient/MailboxFull",
      source: "ses-bounce",
    });
    expect(await service.releaseTransient("full@example.test")).toBe(true);
    expect(await service.isSuppressed("full@example.test")).toBe(false);
  });

  /** A complaint is a decision, not a fact about a mailbox. */
  it("never lifts a permanent entry, however many deliveries follow", async () => {
    const { service } = build();
    await service.suppress({
      email: "cross@example.test",
      permanence: "permanent",
      reason: "abuse",
      source: "ses-complaint",
    });
    expect(await service.releaseTransient("cross@example.test")).toBe(false);
    expect(await service.isSuppressed("cross@example.test")).toBe(true);
  });

  it("is a no-op for an address that was never suppressed", async () => {
    const { service } = build();
    expect(await service.releaseTransient("stranger@example.test")).toBe(false);
  });
});

describe("when Redis is unavailable", () => {
  /**
   * Fails **open**. The alternative — treating an unreadable list as "suppress
   * everything" — turns a cache outage into every user being locked out of their
   * own account, which is a far worse failure than one message to a dead mailbox.
   */
  it("allows the send rather than blocking every message", async () => {
    const db = new FakeDb();
    const service = new SuppressionService(
      {
        client: {
          get: async () => {
            throw new Error("connection refused");
          },
          set: async () => {
            throw new Error("connection refused");
          },
        },
      } as unknown as RedisService,
      createFakePrisma(db) as unknown as PrismaService,
    );

    expect(await service.isSuppressed("asha@example.test")).toBe(false);
    // The audit row is still written, so the fact is not lost with the cache.
    await service.suppress({
      email: "asha@example.test",
      permanence: "permanent",
      reason: "abuse",
      source: "ses-complaint",
    });
    expect(db.auditRows).toHaveLength(1);
  });
});

describe("the skip audit row", () => {
  it("names the kind that was not sent", async () => {
    const { service, db } = build();
    await service.recordSkip("asha@example.test", "low-credits", {
      permanence: "permanent",
      reason: "abuse",
      at: new Date().toISOString(),
    });
    expect(db.auditRows[0]?.action).toBe("notify.send.skipped");
    expect(db.auditRows[0]?.data).toMatchObject({ kind: "low-credits", reason: "abuse" });
  });
});
