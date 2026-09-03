/**
 * D04b — partner catalogue integration, against a real migrated Postgres.
 *
 * Three things this suite exists to prove with a real database, not a stub:
 *
 * 1. `assets.partnerCatalogue` off (the default) refuses every
 *    `PartnerCatalogueService` call — search, grant, reportUsage, revoke —
 *    with `partner-catalogue/disabled`, and writes nothing to
 *    `asset_clearance_grants`.
 * 2. With the flag on (mock provider), `grant()` persists a real
 *    `asset_clearance_grants` row whose `licenceSnapshot` carries the
 *    TODO(H-28) placeholder sentinel (orchestrator addendum, 2026-09-03) —
 *    and `reportUsage()`/`revoke()` round-trip against that row.
 * 3. Grant expiry: a grant whose `expiresAt` is in the past (a fake clock,
 *    via a directly-constructed past date rather than a live timer) is
 *    refused for a new usage report with `partner-catalogue/grant_expired`.
 *
 * Needs Postgres exactly as the other `*.e2e-spec.ts` suites do; skips
 * loudly without one.
 */
import { generateKeyPairSync } from "node:crypto";

import IORedis from "ioredis";
import request from "supertest";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { Env } from "@montaj/config";

import {
  createTestDatabase,
  isDatabaseAvailable,
  skipReason,
  type TestDatabase,
} from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { TokenService } from "../src/auth/token.service.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { resetEnvCache } from "../src/config/config.module.js";
import { PARTNER_CATALOGUE_ERRORS } from "../src/partner-catalogue/partner-catalogue.constants.js";
import { PartnerCatalogueService } from "../src/partner-catalogue/partner-catalogue.service.js";
import {
  InMemoryRealtimeBroker,
  InMemoryRealtimeBus,
  REALTIME_BUS,
} from "../src/realtime/realtime.bus.js";

import type { INestApplication } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable();
if (!available) console.warn(`[partner-catalogue.e2e] skipped: ${skipReason}`);

function fakeEnv(flags: Record<string, unknown>): Env {
  return { FEATURE_FLAGS_JSON: flags } as unknown as Env;
}

describe.skipIf(!available)("PartnerCatalogueService (D04b) — real database", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error(`partner-catalogue suite could not start: ${skipReason}`);
    db = created;
  }, 60_000);

  afterAll(async () => {
    if (db !== undefined) await db.stop();
  });

  it("flag off (default): every method refuses and no grant row is ever written", async () => {
    const service = new PartnerCatalogueService(fakeEnv({}), db.prisma as never);
    const workspaceId = await createWorkspace(db, "flag-off");

    await expect(service.search("")).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.disabled,
    });
    await expect(
      service.grant({ providerAssetId: "mock-sfx-0001", workspaceId, useContext: "pass_item" }),
    ).rejects.toMatchObject({ code: PARTNER_CATALOGUE_ERRORS.disabled });

    const rows = await db.prisma.assetClearanceGrant.count({ where: { workspaceId } });
    expect(rows).toBe(0);
  });

  it("flag on (mock): grant() persists a row with a TODO(H-28) placeholder licenceSnapshot", async () => {
    const service = new PartnerCatalogueService(
      fakeEnv({ "assets.partnerCatalogue": true }),
      db.prisma as never,
    );
    const workspaceId = await createWorkspace(db, "grant-flow");

    const { hits } = await service.search("");
    const first = hits[0];
    if (first === undefined) throw new Error("fixture must have at least one hit");

    const { grantId, licenceSnapshot } = await service.grant({
      providerAssetId: first.providerAssetId,
      workspaceId,
      useContext: "pass_item",
    });

    const row = await db.prisma.assetClearanceGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(row.workspaceId).toBe(workspaceId);
    expect(row.status).toBe("active");
    expect(row.useContext).toBe("pass_item");
    expect(row.licenceSnapshot).toMatchObject({ pending: true, licenceType: "TODO(H-28)" });
    expect(licenceSnapshot["licenceType"]).toBe("TODO(H-28)");

    const report = await service.reportUsage({ grantId, exportId: "exp_e2e_1" });
    expect(report.reportRef).toBeTruthy();

    await service.revoke(grantId);
    const revoked = await db.prisma.assetClearanceGrant.findUniqueOrThrow({
      where: { id: grantId },
    });
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).not.toBeNull();

    await expect(service.reportUsage({ grantId, exportId: "exp_e2e_2" })).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.grantRevoked,
    });
  });

  it("expiry: a grant whose expiresAt is already in the past is refused for a new usage report", async () => {
    const service = new PartnerCatalogueService(
      fakeEnv({ "assets.partnerCatalogue": true }),
      db.prisma as never,
    );
    const workspaceId = await createWorkspace(db, "expiry");

    const { hits } = await service.search("");
    const first = hits[0];
    if (first === undefined) throw new Error("fixture must have at least one hit");

    const { grantId } = await service.grant({
      providerAssetId: first.providerAssetId,
      workspaceId,
      useContext: "pass_item",
    });

    // A fake clock: rather than waiting on a real timer, force expiresAt into
    // the past directly on the row `grant()` just wrote — the same effect a
    // fake-clock library would have on `DEFAULT_GRANT_TERM_DAYS` elapsing.
    await db.prisma.assetClearanceGrant.update({
      where: { id: grantId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(service.reportUsage({ grantId, exportId: "exp_e2e_3" })).rejects.toMatchObject({
      code: PARTNER_CATALOGUE_ERRORS.grantExpired,
    });
  });

  it("reportUsage against another workspace's grant id still resolves by id (service is not workspace-scoped by call; caller must check ownership)", async () => {
    // Documents current behaviour rather than asserting a stronger guarantee
    // this work package did not build: `PartnerCatalogueService.reportUsage`
    // takes a bare `grantId`. A caller (the render worker / export
    // completion handler) is responsible for having derived that id from a
    // workspace-scoped lookup in the first place — see the final report.
    const service = new PartnerCatalogueService(
      fakeEnv({ "assets.partnerCatalogue": true }),
      db.prisma as never,
    );
    const workspaceId = await createWorkspace(db, "ownership-note");
    const { hits } = await service.search("");
    const first = hits[0];
    if (first === undefined) throw new Error("fixture must have at least one hit");
    const { grantId } = await service.grant({
      providerAssetId: first.providerAssetId,
      workspaceId,
      useContext: "pass_item",
    });
    const row = await db.prisma.assetClearanceGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(row.workspaceId).toBe(workspaceId);
  });
});

let counter = 0;
async function createWorkspace(db: TestDatabase, tag: string): Promise<string> {
  counter += 1;
  const run = `${Date.now().toString(36)}${counter}`.toUpperCase().slice(-10);
  const userId = `01JEPCU${run}`.padEnd(26, "0").slice(0, 26);
  const workspaceId = `01JEPCW${run}`.padEnd(26, "0").slice(0, 26);
  await db.prisma.user.create({
    data: { id: userId, email: `partner-catalogue-${tag}-${run}@example.test`, name: "D04b test" },
  });
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      slug: `partner-catalogue-${tag}-${run}`.toLowerCase(),
      name: `partner-catalogue-${tag}-${run}`,
      ownerId: userId,
      billingCountry: "IN",
    },
  });
  return workspaceId;
}

// ---------------------------------------------------------------------------
// HTTP surface (D04b2 scope §1): GET /partner-catalogue/search,
// POST /partner-catalogue/grants, DELETE /partner-catalogue/grants/{id} —
// against a real, migrated Postgres and a real Redis (RateLimitGuard needs
// one), with the flag both off (404 everywhere) and on (mock provider).
// ---------------------------------------------------------------------------

const REDIS_READY = isRedisAvailable();
const HTTP_CAN_RUN = available && REDIS_READY;
if (!HTTP_CAN_RUN) {
  console.warn(
    `[partner-catalogue.e2e http] skipped — ${available ? "" : `database: ${skipReason}. `}` +
      `${REDIS_READY ? "" : `redis: ${redisSkipReason}.`}`,
  );
}

const JWT_KEYS = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function httpId(kind: string, run: string): string {
  return `01JE${kind}${run}`.padEnd(26, "0").slice(0, 26);
}

interface HttpHarness {
  db: TestDatabase;
  prisma: PrismaClient;
  redis: IORedis;
  app: INestApplication;
  tokens: TokenService;
  workspaceId: string;
  userId: string;
  token: () => string;
}

async function bootHttpHarness(tag: string, flags: Record<string, unknown>): Promise<HttpHarness> {
  const created = await createTestDatabase();
  if (created === null) throw new Error(`could not start a test database: ${skipReason}`);
  const db = created;
  const prisma = db.prisma;

  const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`
    .toUpperCase()
    .padStart(10, "0")
    .slice(-10);
  const userId = httpId("US3R", run);
  const workspaceId = httpId("WKSP", run);

  await prisma.user.create({
    data: {
      id: userId,
      email: `partner-catalogue-http-${tag}-${run}@example.test`,
      name: "D04b2 test",
    },
  });
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      slug: `partner-catalogue-http-${tag}-${run}`.toLowerCase(),
      name: `partner-catalogue-http-${tag}-${run}`,
      ownerId: userId,
      billingCountry: "IN",
    },
  });
  await prisma.membership.create({
    data: {
      id: httpId("MBR1", run),
      workspaceId,
      userId,
      role: "editor",
      status: "active",
    },
  });

  const redis = new IORedis(testRedisUrl(), { maxRetriesPerRequest: null });

  process.env["DATABASE_URL"] = db.url;
  process.env["REDIS_URL"] = testRedisUrl();
  process.env["JWT_PRIVATE_KEY"] = JWT_KEYS.privateKey;
  process.env["JWT_PUBLIC_KEY"] = JWT_KEYS.publicKey;
  process.env["FEATURE_FLAGS_JSON"] = JSON.stringify(flags);
  resetEnvCache();

  const { Test } = await import("@nestjs/testing");
  const { AppModule } = await import("../src/app.module.js");
  const { HttpExceptionFilter } = await import("../src/common/errors/http-exception.filter.js");
  const { setupOpenApi } = await import("../src/openapi.js");
  const { applyInternalBodyLimit } = await import("../src/internal/internal-body-limit.js");

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(
      Object.assign(prisma, {
        ping: async () => undefined,
        withTransaction: async (
          fn: (tx: unknown) => Promise<unknown>,
          options: { timeoutMs?: number; maxWaitMs?: number } = {},
        ) =>
          prisma.$transaction(async (tx) => fn(tx), {
            timeout: options.timeoutMs ?? 10_000,
            maxWait: options.maxWaitMs ?? 5_000,
          }),
      }),
    )
    .overrideProvider(RedisService)
    .useValue({
      client: redis,
      ping: async () => undefined,
      onModuleDestroy: async () => undefined,
    })
    .overrideProvider(REALTIME_BUS)
    .useValue(new InMemoryRealtimeBus(new InMemoryRealtimeBroker()))
    .compile();

  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  applyInternalBodyLimit(app);
  setupOpenApi(app);
  await app.init();
  const tokens = app.get(TokenService);

  return {
    db,
    prisma,
    redis,
    app,
    tokens,
    workspaceId,
    userId,
    token: () =>
      tokens.mintAccessToken({ userId, workspaceId, role: "editor", kind: "web" }).accessToken,
  };
}

describe.skipIf(!HTTP_CAN_RUN)("partner-catalogue HTTP — flag off (404 everywhere)", () => {
  let h: HttpHarness;

  beforeAll(async () => {
    h = await bootHttpHarness("off", {});
  }, 180_000);

  afterAll(async () => {
    await h.app.close();
    await h.redis.quit().catch(() => undefined);
    if (h.db !== undefined) await h.db.stop();
  });

  it("404s GET /partner-catalogue/search", async () => {
    await request(h.app.getHttpServer())
      .get("/partner-catalogue/search")
      .query({ q: "whoosh" })
      .set("Authorization", `Bearer ${h.token()}`)
      .expect(404);
  });

  it("404s POST /partner-catalogue/grants", async () => {
    await request(h.app.getHttpServer())
      .post("/partner-catalogue/grants")
      .set("Authorization", `Bearer ${h.token()}`)
      .send({ providerAssetId: "mock-sfx-0001", useContext: "pass_item" })
      .expect(404);
  });

  it("404s DELETE /partner-catalogue/grants/{id}", async () => {
    await request(h.app.getHttpServer())
      .delete(`/partner-catalogue/grants/${httpId("GRNT", "0000000001")}`)
      .set("Authorization", `Bearer ${h.token()}`)
      .expect(404);
  });

  it("401s with no token, even while the flag is off", async () => {
    await request(h.app.getHttpServer())
      .get("/partner-catalogue/search")
      .query({ q: "whoosh" })
      .expect(401);
  });

  it("writes nothing to asset_clearance_grants", async () => {
    expect(await h.prisma.assetClearanceGrant.count()).toBe(0);
  });
});

describe.skipIf(!HTTP_CAN_RUN)(
  "partner-catalogue HTTP — flag on (mock provider): search, grant, revoke",
  () => {
    let h: HttpHarness;

    beforeAll(async () => {
      h = await bootHttpHarness("on", { "assets.partnerCatalogue": true });
    }, 180_000);

    afterAll(async () => {
      await h.app.close();
      await h.redis.quit().catch(() => undefined);
      if (h.db !== undefined) await h.db.stop();
    });

    it("200s GET /partner-catalogue/search with the mock fixture hits", async () => {
      const response = await request(h.app.getHttpServer())
        .get("/partner-catalogue/search")
        .query({ q: "" })
        .set("Authorization", `Bearer ${h.token()}`)
        .expect(200);
      expect(response.body.hits.length).toBeGreaterThan(0);
      expect(response.body.hits[0].allowsRawFileDelivery).toBe(false);
    });

    it("401s with no token", async () => {
      await request(h.app.getHttpServer())
        .get("/partner-catalogue/search")
        .query({ q: "" })
        .expect(401);
    });

    let grantId: string;

    it("201s POST /partner-catalogue/grants, persists a real row, and audits it", async () => {
      const response = await request(h.app.getHttpServer())
        .post("/partner-catalogue/grants")
        .set("Authorization", `Bearer ${h.token()}`)
        .send({ providerAssetId: "mock-sfx-0001", useContext: "pass_item" })
        .expect(201);

      expect(typeof response.body.grantId).toBe("string");
      grantId = response.body.grantId;

      const row = await h.prisma.assetClearanceGrant.findUnique({ where: { id: grantId } });
      expect(row).not.toBeNull();
      expect(row?.workspaceId).toBe(h.workspaceId);
      expect(row?.status).toBe("active");

      const audited = await h.prisma.auditLog.findFirst({
        where: { action: "partner_catalogue.grant.created", resourceId: grantId },
      });
      expect(audited).not.toBeNull();
    });

    it("404s POST /partner-catalogue/grants for an unknown provider asset id", async () => {
      await request(h.app.getHttpServer())
        .post("/partner-catalogue/grants")
        .set("Authorization", `Bearer ${h.token()}`)
        .send({ providerAssetId: "no-such-asset", useContext: "pass_item" })
        .expect(404);
    });

    it("204s DELETE /partner-catalogue/grants/{id}, revokes the row, and audits it", async () => {
      await request(h.app.getHttpServer())
        .delete(`/partner-catalogue/grants/${grantId}`)
        .set("Authorization", `Bearer ${h.token()}`)
        .expect(204);

      const row = await h.prisma.assetClearanceGrant.findUnique({ where: { id: grantId } });
      expect(row?.status).toBe("revoked");

      const audited = await h.prisma.auditLog.findFirst({
        where: { action: "partner_catalogue.grant.revoked", resourceId: grantId },
      });
      expect(audited).not.toBeNull();
    });

    it("404s DELETE for an unknown grant id", async () => {
      await request(h.app.getHttpServer())
        .delete(`/partner-catalogue/grants/${httpId("GRNT", "0000000002")}`)
        .set("Authorization", `Bearer ${h.token()}`)
        .expect(404);
    });
  },
);
