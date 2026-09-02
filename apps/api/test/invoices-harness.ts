/**
 * A booted API with a real PostgreSQL, for B05's invoice/tax integration
 * tests — modelled directly on `billing-harness.ts` (same reasoning: A23a's
 * one-Postgres-per-run, a private cloned database per suite).
 *
 * Storage is the REAL `DERIVED_STORE` against the shared MinIO (brief setup:
 * "MinIO from the shared stack for PDF storage") when it is reachable
 * (`minio-harness.ts`'s `isStorageAvailable`); tests that need a stored PDF
 * are gated on that the same way `media-pipeline.e2e-spec.ts` gates its own.
 */
import { generateKeyPairSync } from "node:crypto";

import { Test } from "@nestjs/testing";
import { type PrismaClient } from "@prisma/client";
import Redis from "ioredis";

import { createTestDatabase, type TestDatabase } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { seedUlid } from "../prisma/seed-data.js";
import { AppModule } from "../src/app.module.js";
import { TokenService } from "../src/auth/token.service.js";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter.js";
import { resetEnvCache } from "../src/config/config.module.js";
import { TaxRegistrationsService } from "../src/invoices/tax-registrations/tax-registrations.service.js";
import { setupOpenApi } from "../src/openapi.js";

import type { INestApplication } from "@nestjs/common";

export interface InvoicesTestContext {
  readonly app: INestApplication;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  /** A confirmed INR workspace, Maharashtra (state 27), no GSTIN — B2C. */
  readonly workspaceId: string;
  /** A confirmed USD workspace (United States) — export. */
  readonly usdWorkspaceId: string;
  readonly userId: string;
  createWorkspace(input: {
    readonly billingCountry: string;
    readonly billingStateCode?: string | null;
    readonly gstin?: string | null;
    readonly currency?: "INR" | "USD";
  }): Promise<string>;
  stop(): Promise<void>;
}

export let invoicesSkipReason = "";

function generateJwtKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey, publicKey };
}

export async function createInvoicesTestContext(): Promise<InvoicesTestContext | null> {
  if (!isRedisAvailable()) {
    invoicesSkipReason = redisSkipReason;
    return null;
  }

  let database: TestDatabase | null = null;
  let redisUrl: string;
  try {
    database = await createTestDatabase();
    if (database === null) {
      invoicesSkipReason = "no test database";
      return null;
    }
    redisUrl = testRedisUrl();
  } catch (error) {
    invoicesSkipReason = error instanceof Error ? error.message : String(error);
    if (database !== null) await database.stop();
    return null;
  }

  const keys = generateJwtKeys();
  process.env["DATABASE_URL"] = database.url;
  process.env["REDIS_URL"] = redisUrl;
  process.env["JWT_PRIVATE_KEY"] = keys.privateKey;
  process.env["JWT_PUBLIC_KEY"] = keys.publicKey;
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
  void tokens; // reserved for a future HTTP-level suite; kept for parity with billing-harness

  const taxRegistrations = app.get(TaxRegistrationsService);
  await taxRegistrations.upsert({
    jurisdiction: "IN",
    taxIdType: "GSTIN",
    taxId: "27AAPFU0939F1ZV",
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    lutNumber: "AD270825001234A",
    lutValidTo: new Date("2027-03-31T00:00:00.000Z"),
  });

  const userId = seedUlid("invoices-suite-user");
  const workspaceId = seedUlid("invoices-suite-ws-inr");
  const usdWorkspaceId = seedUlid("invoices-suite-ws-usd");
  const now = new Date();

  await prisma.user.create({
    data: {
      id: userId,
      email: `invoices-${userId.toLowerCase()}@example.test`,
      name: "Invoices tester",
    },
  });
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      slug: `ws-inr-${workspaceId.toLowerCase()}`,
      name: "Invoices INR",
      ownerId: userId,
      region: "in",
      currency: "INR",
      billingCountry: "IN",
      billingCountryConfirmedAt: now,
      billingStateCode: "27",
    },
  });
  await prisma.membership.create({
    data: { id: seedUlid("im1"), workspaceId, userId, role: "owner", status: "active" },
  });
  await prisma.workspace.create({
    data: {
      id: usdWorkspaceId,
      slug: `ws-usd-${usdWorkspaceId.toLowerCase()}`,
      name: "Invoices USD",
      ownerId: userId,
      region: "us",
      currency: "USD",
      billingCountry: "US",
      billingCountryConfirmedAt: now,
    },
  });
  await prisma.membership.create({
    data: {
      id: seedUlid("im2"),
      workspaceId: usdWorkspaceId,
      userId,
      role: "owner",
      status: "active",
    },
  });

  let extraCount = 0;

  return {
    app,
    prisma,
    redis,
    workspaceId,
    usdWorkspaceId,
    userId,

    async createWorkspace(input) {
      extraCount += 1;
      const id = seedUlid(`invoices-extra-ws-${extraCount}-${Date.now()}`);
      await prisma.workspace.create({
        data: {
          id,
          slug: `ws-extra-${id.toLowerCase()}`,
          name: "Invoices extra",
          ownerId: userId,
          region: input.billingCountry === "IN" ? "in" : "us",
          currency: input.currency ?? (input.billingCountry === "IN" ? "INR" : "USD"),
          billingCountry: input.billingCountry,
          billingCountryConfirmedAt: now,
          ...(input.billingStateCode === undefined
            ? {}
            : { billingStateCode: input.billingStateCode }),
          ...(input.gstin === undefined ? {} : { gstin: input.gstin }),
        },
      });
      await prisma.membership.create({
        data: {
          id: seedUlid(`im-extra-${id}`),
          workspaceId: id,
          userId,
          role: "owner",
          status: "active",
        },
      });
      return id;
    },

    async stop() {
      redis.disconnect();
      await app.close();
      await database?.stop();
    },
  };
}
