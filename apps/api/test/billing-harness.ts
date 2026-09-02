/**
 * A booted API with a real PostgreSQL and a real Redis, seeded with the plan
 * catalogue and two confirmed workspaces (INR and USD) plus a helper to create
 * an unconfirmed one for the tax-profile gate.
 *
 * A23a: the services are the run's, not this suite's — `test/global-setup.ts`
 * starts one PostgreSQL and one Redis for the whole run; this harness clones
 * the migrated template into a database of its own and uses the logical Redis
 * database this suite owns, and skips loudly when neither Docker nor
 * `TEST_DATABASE_URL` is available, exactly as `edg-harness.ts` does.
 *
 * The template database is migrated but not seeded (`global-setup.ts` has no
 * `db:seed` step), so the plan catalogue is inserted here from
 * `prisma/seed-data.ts`'s own `PLAN_SEEDS` — the same values `pnpm db:seed`
 * writes — rather than duplicated as literals that could drift from it.
 */
import { generateKeyPairSync } from "node:crypto";

import { Test } from "@nestjs/testing";
import { type PrismaClient, type $Enums } from "@prisma/client";
import Redis from "ioredis";

import { createTestDatabase, type TestDatabase } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { PLAN_SEEDS, seedUlid } from "../prisma/seed-data.js";
import { AppModule } from "../src/app.module.js";
import { TokenService } from "../src/auth/token.service.js";
import { BILLING_PROVIDER } from "../src/billing/provider.js";
import { type FakeProvider } from "../src/billing/providers/fake.provider.js";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter.js";
import { resetEnvCache } from "../src/config/config.module.js";
import { setupOpenApi } from "../src/openapi.js";

import type { INestApplication } from "@nestjs/common";

export interface BillingTestContext {
  readonly app: INestApplication;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly provider: FakeProvider;
  /** A confirmed INR workspace (Maharashtra). */
  readonly workspaceId: string;
  /** A confirmed USD workspace (United States). */
  readonly usdWorkspaceId: string;
  readonly userId: string;
  token(role?: $Enums.MembershipRole, workspaceId?: string): string;
  /** A fresh workspace whose `billingCountryConfirmedAt` is still null. */
  createUnconfirmedWorkspace(): Promise<string>;
  planId(key: $Enums.PlanKey): Promise<string>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export let billingSkipReason = "";

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

export async function createBillingTestContext(): Promise<BillingTestContext | null> {
  if (!isRedisAvailable()) {
    billingSkipReason = redisSkipReason;
    return null;
  }

  let database: TestDatabase | null = null;
  let redisUrl: string;
  try {
    database = await createTestDatabase();
    if (database === null) {
      billingSkipReason = "no test database";
      return null;
    }
    redisUrl = testRedisUrl();
  } catch (error) {
    billingSkipReason = error instanceof Error ? error.message : String(error);
    if (database !== null) await database.stop();
    return null;
  }

  const keys = generateJwtKeys();
  process.env["DATABASE_URL"] = database.url;
  process.env["REDIS_URL"] = redisUrl;
  process.env["JWT_PRIVATE_KEY"] = keys.privateKey;
  process.env["JWT_PUBLIC_KEY"] = keys.publicKey;
  // No RAZORPAY_* — `createBillingProvider` falls back to `FakeProvider`,
  // exactly as it would in any environment without live keys.
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

  const userId = seedUlid("billing-suite-user");
  const workspaceId = seedUlid("billing-suite-ws-inr");
  const usdWorkspaceId = seedUlid("billing-suite-ws-usd");
  const now = new Date();

  async function seedTenant(): Promise<void> {
    await prisma.user.create({
      data: {
        id: userId,
        email: `billing-${userId.toLowerCase()}@example.test`,
        name: "Billing tester",
      },
    });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `ws-inr-${workspaceId.toLowerCase()}`,
        name: "Billing INR",
        ownerId: userId,
        region: "in",
        currency: "INR",
        billingCountry: "IN",
        billingCountryConfirmedAt: now,
        billingStateCode: "27",
      },
    });
    await prisma.membership.create({
      data: { id: seedUlid("m1"), workspaceId, userId, role: "owner", status: "active" },
    });
    await prisma.workspace.create({
      data: {
        id: usdWorkspaceId,
        slug: `ws-usd-${usdWorkspaceId.toLowerCase()}`,
        name: "Billing USD",
        ownerId: userId,
        region: "us",
        currency: "USD",
        billingCountry: "US",
        billingCountryConfirmedAt: now,
      },
    });
    await prisma.membership.create({
      data: {
        id: seedUlid("m2"),
        workspaceId: usdWorkspaceId,
        userId,
        role: "owner",
        status: "active",
      },
    });
  }

  await seedTenant();

  return {
    app,
    prisma,
    redis,
    provider,
    workspaceId,
    usdWorkspaceId,
    userId,

    token(role = "admin", ws = workspaceId) {
      return tokens.mintAccessToken({ userId, workspaceId: ws, role, kind: "web" }).accessToken;
    },

    async createUnconfirmedWorkspace() {
      const id = seedUlid(`unconfirmed-${Date.now()}-${Math.random()}`);
      await prisma.workspace.create({
        data: {
          id,
          slug: `ws-unconfirmed-${id.toLowerCase()}`,
          name: "Unconfirmed",
          ownerId: userId,
          region: "in",
          currency: "INR",
          billingCountry: "IN",
        },
      });
      await prisma.membership.create({
        data: {
          id: seedUlid(`mm-${id}`),
          workspaceId: id,
          userId,
          role: "owner",
          status: "active",
        },
      });
      return id;
    },

    async planId(key: $Enums.PlanKey) {
      const plan = await prisma.plan.findUniqueOrThrow({ where: { key } });
      return plan.id;
    },

    async reset() {
      // `payments.mandateId` is `onDelete: SetNull`, so deleting a mandate
      // does NOT delete its payments — and `provider.reset()` restarts the
      // fake's id counter from 1 every time, so a leftover payment from an
      // earlier test can collide with a freshly-minted id in a later one
      // unless payments are cleared here too.
      await prisma.payment.deleteMany({});
      await prisma.mandate.deleteMany({});
      await prisma.subscription.deleteMany({});
      await prisma.passPurchase.deleteMany({});
      await prisma.billingEvent.deleteMany({});
      await prisma.auditLog.deleteMany({});
      provider.reset();
    },

    async stop() {
      redis.disconnect();
      await app.close();
      await database?.stop();
    },
  };
}
