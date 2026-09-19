import { describe, expect, it, vi } from "vitest";

import { CANARY_PREFIX, HealthService } from "./health.service.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { RedisService } from "../common/redis/redis.service.js";
import type { ObjectStore } from "../common/storage/object-store.js";

interface StoreBehaviour {
  /** Throw from the signed `head` the readiness probe makes. */
  headFails?: Error;
  /** Throw from the boot canary's write. */
  putFails?: Error;
  /** Hand back bytes other than the ones written. */
  corruptRead?: boolean;
}

function fakeStore(bucket: string, behaviour: StoreBehaviour = {}) {
  const written = new Map<string, string>();
  const deleted: string[] = [];

  const store = {
    bucket,
    kind: "s3" as const,
    head: vi.fn(async () => {
      if (behaviour.headFails !== undefined) throw behaviour.headFails;
      // A signed HEAD for a key that does not exist: the store answered, which
      // is all the per-probe check claims to know.
      return null;
    }),
    put: vi.fn(async ({ key, body }: { key: string; body: string | Uint8Array }) => {
      if (behaviour.putFails !== undefined) throw behaviour.putFails;
      written.set(key, String(body));
    }),
    get: vi.fn(async (key: string) =>
      Buffer.from(behaviour.corruptRead === true ? "not what was written" : (written.get(key) ?? "")),
    ),
    delete: vi.fn(async (key: string) => {
      deleted.push(key);
      written.delete(key);
    }),
  } as unknown as ObjectStore;

  return { store, written, deleted };
}

function serviceWith(options: {
  db?: () => Promise<void>;
  redis?: () => Promise<void>;
  raw?: StoreBehaviour;
  derived?: StoreBehaviour;
}) {
  const prisma = { ping: vi.fn(options.db ?? (async () => undefined)) } as unknown as PrismaService;
  const redis = {
    ping: vi.fn(options.redis ?? (async () => undefined)),
  } as unknown as RedisService;
  const raw = fakeStore("montaj-raw", options.raw);
  const derived = fakeStore("montaj-derived", options.derived);

  return {
    service: new HealthService(prisma, redis, raw.store, derived.store),
    raw,
    derived,
  };
}

/** A booted service: the canary has run, as it would have in a real process. */
async function booted(options: Parameters<typeof serviceWith>[0] = {}) {
  const harness = serviceWith(options);
  await harness.service.onApplicationBootstrap();
  return harness;
}

describe("the object-store canary", () => {
  /**
   * The probe this replaced sent an *unauthenticated* HEAD and counted 403 as
   * "up", so it passed with no credentials, the wrong credentials, a read-only
   * role, or the derived store entirely unreachable (P0-10).
   */
  it("writes, reads back and deletes an object on both stores", async () => {
    const { raw, derived } = await booted();

    expect(raw.store.put).toHaveBeenCalledTimes(1);
    expect(derived.store.put).toHaveBeenCalledTimes(1);
    expect(raw.store.get).toHaveBeenCalledTimes(1);
    expect(derived.store.get).toHaveBeenCalledTimes(1);
  });

  it("leaves nothing behind", async () => {
    const { raw, derived } = await booted();

    expect(raw.written.size).toBe(0);
    expect(derived.written.size).toBe(0);
    expect(raw.deleted).toHaveLength(1);
    expect(derived.deleted).toHaveLength(1);
  });

  it("writes under a prefix an IAM policy can scope to", async () => {
    const { raw } = await booted();
    const key = (raw.store.put as unknown as { mock: { calls: [{ key: string }][] } }).mock
      .calls[0]?.[0].key;
    expect(key?.startsWith(CANARY_PREFIX)).toBe(true);
  });

  it("uses a different key per process so two replicas cannot race", async () => {
    const first = await booted();
    const second = await booted();
    const keyOf = (store: ObjectStore): string =>
      (store.put as unknown as { mock: { calls: [{ key: string }][] } }).mock.calls[0]?.[0].key ??
      "";
    expect(keyOf(first.raw.store)).not.toBe(keyOf(second.raw.store));
  });

  it("cleans up even when the read back fails", async () => {
    const { derived } = await booted({ derived: { corruptRead: true } });
    expect(derived.deleted).toHaveLength(1);
  });
});

describe("HealthService.readiness", () => {
  it("reports ok with a latency per dependency when everything answers", async () => {
    const { service } = await booted();
    const report = await service.readiness();

    expect(report.status).toBe("ok");
    expect(report.checks.db.status).toBe("up");
    expect(report.checks.redis.status).toBe("up");
    expect(report.checks.storage.status).toBe("up");
    expect(report.checks.db.latencyMs).toBeGreaterThanOrEqual(0);
  });

  /**
   * The whole point of moving to a signed request: a credential the store
   * rejects is now "down", where the unauthenticated probe read the resulting
   * 403 as proof of health.
   */
  it("is down when the store rejects the signature", async () => {
    const { service } = await booted({ raw: { headFails: new Error("403 SignatureDoesNotMatch") } });
    const report = await service.readiness();

    expect(report.status).toBe("degraded");
    expect(report.checks.storage.status).toBe("down");
    expect(report.checks.storage.error).toContain("SignatureDoesNotMatch");
  });

  it("is down when only the derived store is unreachable", async () => {
    const { service } = await booted({
      derived: { headFails: new Error("getaddrinfo ENOTFOUND r2") },
    });
    const report = await service.readiness();
    expect(report.checks.storage.status).toBe("down");
  });

  /**
   * A pod that cannot write, read back and delete its own object cannot serve
   * uploads or exports. Staying down turns that into an automatic rollback
   * under `helm --atomic` rather than a silently broken release.
   */
  it("stays down for the life of the process when the boot canary failed", async () => {
    const { service } = await booted({ raw: { putFails: new Error("AccessDenied: PutObject") } });
    const report = await service.readiness();

    expect(report.status).toBe("degraded");
    expect(report.checks.storage.status).toBe("down");
    expect(report.checks.storage.error).toContain("canary failed");
  });

  it("is down before the canary has had a chance to run", async () => {
    const { service } = serviceWith({});
    const report = await service.readiness();
    expect(report.checks.storage.status).toBe("down");
    expect(report.checks.storage.error).toContain("not run yet");
  });

  it("still reports the healthy dependencies when one is down", async () => {
    const { service } = await booted({
      redis: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      },
    });
    const report = await service.readiness();

    expect(report.status).toBe("degraded");
    expect(report.checks.db.status).toBe("up");
    expect(report.checks.redis.status).toBe("down");
    expect(report.checks.redis.error).toContain("ECONNREFUSED");
  });

  it("strips credentials out of a connection error before reporting it", async () => {
    const { service } = await booted({
      db: async () => {
        throw new Error("Can't reach postgresql://montaj:s3cret@db:5432/montaj");
      },
    });
    const report = await service.readiness();

    expect(report.checks.db.error).not.toContain("s3cret");
    expect(report.checks.db.error).toContain("//***@");
  });

  it("caps a very long error message", async () => {
    const { service } = await booted({
      db: async () => {
        throw new Error("x".repeat(500));
      },
    });
    const report = await service.readiness();
    expect(report.checks.db.error?.length).toBeLessThanOrEqual(200);
  });

  it("reports a non-Error rejection without crashing", async () => {
    const { service } = await booted({
      redis: async () => {
        throw "plain string failure";
      },
    });
    const report = await service.readiness();
    expect(report.checks.redis.error).toBe("plain string failure");
  });
});
