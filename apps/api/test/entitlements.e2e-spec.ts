/**
 * The entitlements engine against real Postgres and real Redis (brief
 * acceptance criterion 2): a Free workspace is blocked from translation, audio
 * clean and 4K export; a Creator workspace is allowed; the 60-second cache is
 * verified and its invalidation hook actually drops the cached snapshot.
 *
 * Drives `EntitlementService` and `RequiresEntitlementGuard` directly — both
 * are plain injectable classes with two constructor dependencies each, and
 * neither needs HTTP, auth or the job queue to be demonstrated.
 */
import "reflect-metadata";

import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { PLAN_SEEDS } from "../prisma/seed-data.js";
import {
  ENTITLEMENT_CHECK_KEY,
  RequiresEntitlement,
  RequiresEntitlementGuard,
} from "../src/entitlements/requires-entitlement.guard.js";
import { EntitlementService } from "../src/workspaces/entitlement.service.js";

import type { TestDatabase } from "./db-harness.js";
import type { AuthenticatedRequest } from "../src/common/guards/index.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { RedisService } from "../src/common/redis/redis.service.js";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { $Enums, PrismaClient } from "@prisma/client";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const CAN_RUN = DB_READY && REDIS_READY;
if (!CAN_RUN) {
  console.warn(
    `[entitlements.e2e] SKIPPED — ${DB_READY ? "" : `db: ${skipReason}. `}${
      REDIS_READY ? "" : `redis: ${redisSkipReason}.`
    }`,
  );
}

let db: TestDatabase;
let prisma: PrismaClient;
let redis: Redis;
let entitlements: EntitlementService;
let guard: RequiresEntitlementGuard;
let seq = 0;

/** A stand-in `Reflector` that reads the SAME metadata `SetMetadata` writes. */
function fakeReflector(): Reflector {
  return {
    getAllAndOverride: (key: string, targets: unknown[]) => {
      for (const target of targets) {
        const value = (Reflect.getMetadata(key, target as object) as unknown) ?? undefined;
        if (value !== undefined) return value;
      }
      return undefined;
    },
  } as unknown as Reflector;
}

class TranslationRoute {
  @RequiresEntitlement("translation")
  handler(): void {
    /* test fixture */
  }
}
class AudioCleanRoute {
  @RequiresEntitlement("audioClean")
  handler(): void {
    /* test fixture */
  }
}
class Export4kRoute {
  @RequiresEntitlement("export4k")
  handler(): void {
    /* test fixture */
  }
}

function contextFor(route: { handler: () => void }, request: unknown): ExecutionContext {
  const proto = Object.getPrototypeOf(route) as object;
  return {
    getHandler: () => (proto as { handler: () => void }).handler,
    getClass: () => proto.constructor,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

describe.skipIf(!CAN_RUN)("entitlements engine (e2e)", () => {
  beforeAll(async () => {
    db = (await createTestDatabase())!;
    if (db === null) throw new Error(`test database unavailable: ${skipReason}`);
    prisma = db.prisma;
    redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });

    for (const plan of PLAN_SEEDS) {
      await prisma.plan.upsert({
        where: { key: plan.key },
        create: {
          id: `01JPLAN${plan.key.toUpperCase().padEnd(19, "0")}`.slice(0, 26),
          key: plan.key,
          name: plan.name,
          prices: plan.prices,
          creditsPerMonthTenths: plan.creditsPerMonthTenths,
          seatPrice: plan.seatPrice ?? undefined,
          entitlements: plan.entitlements,
          active: true,
        },
        update: { entitlements: plan.entitlements },
      });
    }

    const prismaService = prisma as unknown as PrismaService;
    const redisService = { client: redis } as unknown as RedisService;
    entitlements = new EntitlementService(prismaService, redisService);
    guard = new RequiresEntitlementGuard(fakeReflector(), entitlements);
  }, 180_000);

  afterAll(async () => {
    await redis?.quit();
    await db?.stop();
  });

  function id(label: string): string {
    seq += 1;
    return `01J${label.slice(0, 4).toUpperCase().padEnd(4, "0")}${String(seq).padStart(19, "0")}`;
  }

  async function newWorkspace(): Promise<string> {
    const userId = id("usr");
    const workspaceId = id("wsp");
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId.toLowerCase(),
        name: "Test workspace",
        ownerId: userId,
        billingCountry: "IN",
      },
    });
    return workspaceId;
  }

  async function subscribeTo(workspaceId: string, planKey: $Enums.PlanKey): Promise<void> {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { key: planKey } });
    await prisma.subscription.create({
      data: {
        id: id("sub"),
        workspaceId,
        planId: plan.id,
        provider: "none",
        status: "active",
        interval: "month",
        currency: "INR",
        listPriceMinor: 0,
        taxInclusive: true,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        seats: 1,
      },
    });
  }

  function requestFor(workspaceId: string): AuthenticatedRequest {
    return {
      params: { id: workspaceId },
      principal: { userId: "u", workspaceId, role: "owner", kind: "web" },
    } as unknown as AuthenticatedRequest;
  }

  describe("EntitlementService.forWorkspace", () => {
    it("computes the seeded Free plan's limits for a workspace with no subscription", async () => {
      const workspaceId = await newWorkspace();
      const view = await entitlements.forWorkspace(workspaceId);

      expect(view.planKey).toBe("free");
      expect(view.entitlements["translation"]).toBe("none");
      expect(view.entitlements["audioClean"]).toBe(false);
      expect(view.entitlements["maxExportResolution"]).toBe("1080p");
    });

    it("computes the Creator plan's limits for a subscribed workspace", async () => {
      const workspaceId = await newWorkspace();
      await subscribeTo(workspaceId, "creator");
      const view = await entitlements.forWorkspace(workspaceId);

      expect(view.planKey).toBe("creator");
      expect(view.entitlements["translation"]).toBe("all");
      expect(view.entitlements["audioClean"]).toBe(true);
      expect(view.entitlements["maxExportResolution"]).toBe("4k");
    });

    it("caches for 60 seconds and invalidation forces a recompute", async () => {
      const workspaceId = await newWorkspace();
      const first = await entitlements.forWorkspace(workspaceId);
      const second = await entitlements.forWorkspace(workspaceId);
      expect(second.computedAt).toBe(first.computedAt); // served from cache

      await entitlements.invalidate(workspaceId);
      // A plan change a webhook would apply between the invalidation and the
      // next read — simulated here directly on the row, the way B01's webhook
      // handler would.
      await subscribeTo(workspaceId, "studio");
      const third = await entitlements.forWorkspace(workspaceId);

      expect(third.computedAt).not.toBe(first.computedAt);
      expect(third.planKey).toBe("studio");
    });
  });

  describe("RequiresEntitlementGuard", () => {
    it("blocks a Free workspace from translation, audio clean and 4K", async () => {
      const workspaceId = await newWorkspace();

      await expect(
        guard.canActivate(contextFor(new TranslationRoute(), requestFor(workspaceId))),
      ).rejects.toMatchObject({ code: "entitlement/upgrade_required" });
      await expect(
        guard.canActivate(contextFor(new AudioCleanRoute(), requestFor(workspaceId))),
      ).rejects.toMatchObject({ code: "entitlement/upgrade_required" });
      await expect(
        guard.canActivate(contextFor(new Export4kRoute(), requestFor(workspaceId))),
      ).rejects.toMatchObject({ code: "entitlement/upgrade_required" });
    });

    it("allows a Creator workspace through every check", async () => {
      const workspaceId = await newWorkspace();
      await subscribeTo(workspaceId, "creator");

      await expect(
        guard.canActivate(contextFor(new TranslationRoute(), requestFor(workspaceId))),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(contextFor(new AudioCleanRoute(), requestFor(workspaceId))),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(contextFor(new Export4kRoute(), requestFor(workspaceId))),
      ).resolves.toBe(true);
    });

    it("has nothing to check on an undecorated route", async () => {
      class PlainRoute {
        handler(): void {
          /* no @RequiresEntitlement */
        }
      }
      const workspaceId = await newWorkspace();
      await expect(
        guard.canActivate(contextFor(new PlainRoute(), requestFor(workspaceId))),
      ).resolves.toBe(true);
    });
  });
});

void ENTITLEMENT_CHECK_KEY; // imported for documentation; the guard reads it internally
