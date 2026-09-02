/**
 * A booted API with a real PostgreSQL and a real Redis for B08's own suites
 * (teams/seats/credits, devices, licensing). Modelled directly on
 * `billing-harness.ts` (B01): same template-database clone, same
 * `TokenService.mintAccessToken` shortcut for a token instead of driving the
 * full HTTP sign-in flow, same `FakeProvider` (no live Razorpay keys).
 *
 * Two differences from `billing-harness.ts`, both deliberate:
 *
 *   1. `CREDITS_FACADE` is left bound to the real `LedgerCreditsFacade` (no
 *      override) -- the pooled-credits acceptance test needs the ledger
 *      actually moving tenths, not a spy on a no-op.
 *   2. `seedTenant` creates a **second** user (`memberUserId`) with no
 *      membership of anything yet, so a test can accept an invitation into
 *      the Agency workspace and watch seats/credits/entitlement actually
 *      change, and an **agency** workspace (unconfirmed billing profile
 *      deliberately -- individual tests confirm it once they need a live
 *      subscription) alongside the plain team one.
 */
import { generateKeyPairSync } from "node:crypto";

import { Test } from "@nestjs/testing";
import { type PrismaClient, type $Enums } from "@prisma/client";
import Redis from "ioredis";

import { createTestDatabase, type TestDatabase } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { PLAN_SEEDS, seedUlid } from "../prisma/seed-data.js";
import { AppModule } from "../src/app.module.js";
import { SessionService } from "../src/auth/session.service.js";
import { TokenService } from "../src/auth/token.service.js";
import { BILLING_PROVIDER } from "../src/billing/provider.js";
import { type FakeProvider } from "../src/billing/providers/fake.provider.js";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter.js";
import { resetEnvCache } from "../src/config/config.module.js";
import { licensingRedisKeys } from "../src/licensing/licensing.constants.js";
import { setupOpenApi } from "../src/openapi.js";
import { workspacesRedisKeys } from "../src/workspaces/workspaces.constants.js";

import type { INestApplication } from "@nestjs/common";

export interface B08TestContext {
  readonly app: INestApplication;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly provider: FakeProvider;
  readonly ownerId: string;
  readonly memberUserId: string;
  /** Studio team workspace, billing profile confirmed. */
  readonly teamWorkspaceId: string;
  /** Agency workspace, billing profile confirmed, no subscription yet. */
  readonly agencyWorkspaceId: string;
  token(userId: string, role: $Enums.MembershipRole, workspaceId: string): string;
  /** Like `token()`, but backed by a real `sessions` row -- needed for any
   * route that writes to the caller's own session (e.g. `POST /devices/register`). */
  sessionToken(userId: string, role: $Enums.MembershipRole, workspaceId: string): Promise<string>;
  planId(key: $Enums.PlanKey): Promise<string>;
  /** Adds an already-active membership directly (skips the invite/accept HTTP round trip). */
  addActiveMember(
    workspaceId: string,
    userId: string,
    role: $Enums.MembershipRole,
  ): Promise<string>;
  createUser(label: string): Promise<string>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export let b08SkipReason = "";

function generateJwtKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey, publicKey };
}

async function seedPlans(prisma: PrismaClient): Promise<void> {
  for (const plan of PLAN_SEEDS) {
    await prisma.plan.upsert({
      where: { key: plan.key },
      create: {
        id: seedUlid(`plan:${plan.key}`),
        key: plan.key,
        name: plan.name,
        prices: plan.prices,
        creditsPerMonthTenths: plan.creditsPerMonthTenths,
        seatPrice: plan.seatPrice ?? undefined,
        entitlements: plan.entitlements,
        active: true,
      },
      update: {},
    });
  }
}

export async function createB08TestContext(): Promise<B08TestContext | null> {
  if (!isRedisAvailable()) {
    b08SkipReason = redisSkipReason;
    return null;
  }

  let database: TestDatabase | null = null;
  let redisUrl: string;
  try {
    database = await createTestDatabase();
    if (database === null) {
      b08SkipReason = "no test database";
      return null;
    }
    redisUrl = testRedisUrl();
  } catch (error) {
    b08SkipReason = error instanceof Error ? error.message : String(error);
    if (database !== null) await database.stop();
    return null;
  }

  const keys = generateJwtKeys();
  process.env["DATABASE_URL"] = database.url;
  process.env["REDIS_URL"] = redisUrl;
  process.env["JWT_PRIVATE_KEY"] = keys.privateKey;
  process.env["JWT_PUBLIC_KEY"] = keys.publicKey;
  process.env["LICENSE_SIGNING_KID"] = "test-k1";
  delete process.env["RAZORPAY_KEY_ID"];
  delete process.env["RAZORPAY_KEY_SECRET"];
  delete process.env["RAZORPAY_WEBHOOK_SECRET"];
  resetEnvCache();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  setupOpenApi(app);
  await app.init();

  const prisma = database.prisma;
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const tokens = app.get(TokenService);
  const provider = app.get(BILLING_PROVIDER) as FakeProvider;

  await seedPlans(prisma);

  const ownerId = seedUlid("b08-owner");
  const memberUserId = seedUlid("b08-member");
  const teamWorkspaceId = seedUlid("b08-ws-team");
  const agencyWorkspaceId = seedUlid("b08-ws-agency");
  const now = new Date();

  async function seedTenant(): Promise<void> {
    await prisma.user.createMany({
      data: [
        { id: ownerId, email: `b08-owner-${ownerId.toLowerCase()}@example.test`, name: "Owner" },
        {
          id: memberUserId,
          email: `b08-member-${memberUserId.toLowerCase()}@example.test`,
          name: "Member",
        },
      ],
    });

    await prisma.workspace.create({
      data: {
        id: teamWorkspaceId,
        slug: `ws-team-${teamWorkspaceId.toLowerCase()}`,
        name: "B08 Team",
        type: "team",
        ownerId,
        region: "in",
        currency: "INR",
        billingCountry: "IN",
        billingCountryConfirmedAt: now,
        billingStateCode: "27",
      },
    });
    await prisma.membership.create({
      data: {
        id: seedUlid("m-team-owner"),
        workspaceId: teamWorkspaceId,
        userId: ownerId,
        role: "owner",
        status: "active",
      },
    });

    await prisma.workspace.create({
      data: {
        id: agencyWorkspaceId,
        slug: `ws-agency-${agencyWorkspaceId.toLowerCase()}`,
        name: "B08 Agency",
        type: "agency",
        ownerId,
        region: "in",
        currency: "INR",
        billingCountry: "IN",
        billingCountryConfirmedAt: now,
        billingStateCode: "27",
      },
    });
    await prisma.membership.create({
      data: {
        id: seedUlid("m-agency-owner"),
        workspaceId: agencyWorkspaceId,
        userId: ownerId,
        role: "owner",
        status: "active",
      },
    });
  }

  await seedTenant();

  let userCounter = 0;

  return {
    app,
    prisma,
    redis,
    provider,
    ownerId,
    memberUserId,
    teamWorkspaceId,
    agencyWorkspaceId,

    token(userId, role, workspaceId) {
      return tokens.mintAccessToken({ userId, workspaceId, role, kind: "web" }).accessToken;
    },

    async sessionToken(userId, role, workspaceId) {
      const issued = await app
        .get(SessionService)
        .issue({ userId, workspaceId, role, kind: "web" });
      return issued.accessToken;
    },

    async planId(key) {
      const plan = await prisma.plan.findUniqueOrThrow({ where: { key } });
      return plan.id;
    },

    async addActiveMember(workspaceId, userId, role) {
      const id = seedUlid(`am-${workspaceId}-${userId}-${Date.now()}-${Math.random()}`);
      await prisma.membership.upsert({
        where: { workspaceId_userId: { workspaceId, userId } },
        create: { id, workspaceId, userId, role, status: "active" },
        update: { role, status: "active" },
      });
      return id;
    },

    async createUser(label) {
      userCounter += 1;
      const id = seedUlid(`b08-user-${label}-${userCounter}-${Date.now()}`);
      await prisma.user.create({
        data: { id, email: `b08-${label}-${id.toLowerCase()}@example.test`, name: label },
      });
      return id;
    },

    async reset() {
      // A test may have transferred ownership (`teamWorkspaceId`'s in
      // particular) -- restore both fixed workspaces to `ownerId` before
      // anything else, so a later test's `token(ownerId, "owner", ...)`
      // is not fighting the DB's live role (`WorkspaceMemberGuard` reads it,
      // not the token's own claim).
      await prisma.workspace.updateMany({
        where: { id: { in: [teamWorkspaceId, agencyWorkspaceId] } },
        data: { ownerId },
      });
      await prisma.membership.updateMany({
        where: { workspaceId: { in: [teamWorkspaceId, agencyWorkspaceId] }, userId: ownerId },
        data: { role: "owner", status: "active" },
      });
      await prisma.session.deleteMany({});
      await prisma.device.deleteMany({});
      await prisma.licenseKey.deleteMany({});
      await prisma.creditLedger.deleteMany({});
      await prisma.creditLot.deleteMany({});
      await prisma.creditHold.deleteMany({});
      await prisma.creditAccount.deleteMany({});
      // `webhooks.service.ts` (B01) dedupes by a derived event id in
      // `billing_events` -- `FakeProvider.reset()` restarts its own id
      // counter from 1, so a webhook fixture in one test can collide with
      // an id already marked processed by an earlier one and be silently
      // treated as a replay, exactly the bug `billing-harness.ts`'s own
      // `reset()` already guards against.
      await prisma.billingEvent.deleteMany({});
      await prisma.payment.deleteMany({});
      await prisma.mandate.deleteMany({});
      await prisma.subscription.deleteMany({});
      await prisma.auditLog.deleteMany({});
      await prisma.accessLog.deleteMany({});
      // Every OTHER membership (not the restored owner above) is scrapped --
      // workspace-agnostic on purpose, since only these two workspaces exist
      // in this harness.
      await prisma.membership.deleteMany({ where: { userId: { not: ownerId } } });
      await prisma.project.deleteMany({});
      await prisma.folder.deleteMany({});
      provider.reset();
      // `EntitlementService` caches per workspace for 60s (07 §Workspaces);
      // this harness reuses the same two workspace ids across every test in
      // a file, so a value cached by one test would otherwise leak into the
      // next one's assertions.
      await redis.del(
        workspacesRedisKeys.entitlement(teamWorkspaceId),
        workspacesRedisKeys.entitlement(agencyWorkspaceId),
        // The signed daily revocation snapshot (`plugins.service.ts`) is
        // cached 24h; a test file spans seconds, so it must never survive
        // between tests either.
        licensingRedisKeys.revocationSnapshot(),
      );
    },

    async stop() {
      redis.disconnect();
      await app.close();
      await database?.stop();
    },
  };
}
