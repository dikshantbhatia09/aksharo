/**
 * A booted API with a real PostgreSQL, a real Redis and a fake Google.
 *
 * Auth is the one module that cannot be tested against substituted
 * infrastructure: refresh families are a database invariant, the rotation grace is
 * a Redis entry, the device-grant poll interval is a Redis `SET NX`, and the point
 * of the tests is that those actually hold.
 *
 * A23a: it no longer STARTS those services. `test/global-setup.ts` provides one
 * PostgreSQL and one Redis for the whole run; this harness takes a private copy of
 * the migrated template database and the logical Redis database this suite owns,
 * and skips loudly when neither Docker nor `TEST_DATABASE_URL` is available,
 * exactly as `database.e2e-spec.ts` does.
 *
 * Google is the exception: the identity provider is a third party, so it is
 * substituted through the `GOOGLE_OAUTH_PROVIDER` port.
 */
import { generateKeyPairSync } from "node:crypto";

import { Test } from "@nestjs/testing";
import { type PrismaClient, type $Enums } from "@prisma/client";
import Redis from "ioredis";
import { ulid } from "ulid";

import { createTestDatabase } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { AdminStepUpService } from "../src/admin/auth/admin-step-up.service.js";
import { currentTotpCode } from "../src/admin/auth/totp.js";
import { AppModule } from "../src/app.module.js";
import { redisKeys } from "../src/auth/auth.constants.js";
import { GOOGLE_OAUTH_PROVIDER } from "../src/auth/google-oauth.provider.js";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { redisKeyPrefix } from "../src/common/redis/redis-keys.js";
import { resetEnvCache } from "../src/config/config.module.js";
import { NotifyConsumer } from "../src/notify/notify.consumer.js";
import { setupOpenApi } from "../src/openapi.js";

import type { TestDatabase } from "./db-harness.js";
import type {
  AuthorizationUrlInput,
  ExchangeInput,
  GoogleOAuthProvider,
  GoogleProfile,
} from "../src/auth/google-oauth.provider.js";
import type { INestApplication } from "@nestjs/common";

/** A Google that answers from a script instead of over the network. */
export class FakeGoogleProvider implements GoogleOAuthProvider {
  readonly configured = true;
  /** Authorization requests seen, so the tests can assert on PKCE. */
  readonly authorizations: AuthorizationUrlInput[] = [];
  /** Code exchanges seen, so the tests can assert the verifier was sent. */
  readonly exchanges: ExchangeInput[] = [];
  /** `code` -> the profile Google would return for it. */
  readonly profiles = new Map<string, GoogleProfile>();

  authorizationUrl(input: AuthorizationUrlInput): string {
    this.authorizations.push(input);
    return `https://accounts.example/authorize?state=${input.state}&code_challenge=${input.codeChallenge}`;
  }

  exchangeCode(input: ExchangeInput): Promise<GoogleProfile> {
    this.exchanges.push(input);
    const profile = this.profiles.get(input.code);
    if (profile === undefined)
      return Promise.reject(new Error(`no fake profile for ${input.code}`));
    return Promise.resolve(profile);
  }
}

/**
 * One development-outbox entry. A04 wrote the first four fields and reads them to
 * finish a flow; A25 added the rendered message, which is how a suite asserts the
 * language a recipient was actually written to in.
 */
export interface OutboxEntry {
  to: string;
  template: string;
  token?: string;
  link: string;
  kind?: string;
  locale?: string;
  subject?: string;
  text?: string;
}

export interface AuthTestContext {
  readonly app: INestApplication;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly google: FakeGoogleProvider;
  /** Empty every table auth touches and every auth key in Redis. */
  reset(): Promise<void>;
  /**
   * The development mail outbox, newest first.
   *
   * Waits for the `notify` queue to drain first. A25 moved delivery onto that
   * queue, so a message is no longer written inline by the request that caused
   * it; draining is deterministic where a sleep would be a flake waiting to
   * happen, and it costs nothing when there is nothing in flight.
   */
  outbox(): Promise<OutboxEntry[]>;
  stop(): Promise<void>;
}

/** Why the suite was skipped, for the console message. */
export let authSkipReason = "";

/**
 * A throwaway RS256 key pair.
 *
 * Generated per run rather than committed: `test/setup-env.ts` ships placeholder
 * PEM text (a real key in the repository would be a shipped secret, THREAT-MODEL
 * T21), and the token service needs a key it can actually sign with.
 */
function generateJwtKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey, publicKey };
}

/** Tables the suite empties between cases, children first. */
const TABLES = [
  "notifications",
  "audit_log",
  "access_logs",
  "consent_records",
  "dsr_requests",
  "device_codes",
  "sessions",
  "identities",
  "memberships",
  "api_keys",
  "subscriptions",
  "workspaces",
  "users",
  // A05: the parental waiting list is not a child of `users` (the entries exist
  // precisely because no account was created), so `CASCADE` never reaches it.
  "parental_waitlist",
];

export async function createAuthTestContext(): Promise<AuthTestContext | null> {
  if (!isRedisAvailable()) {
    authSkipReason = redisSkipReason;
    return null;
  }

  let database: TestDatabase | null = null;
  let redisUrl: string;

  try {
    database = await createTestDatabase();
    if (database === null) {
      authSkipReason = "no test database";
      return null;
    }
    redisUrl = testRedisUrl();
  } catch (error) {
    authSkipReason = error instanceof Error ? error.message : String(error);
    if (database !== null) await database.stop();
    return null;
  }

  const keys = generateJwtKeys();
  process.env["DATABASE_URL"] = database.url;
  process.env["REDIS_URL"] = redisUrl;
  process.env["JWT_PRIVATE_KEY"] = keys.privateKey;
  process.env["JWT_PUBLIC_KEY"] = keys.publicKey;
  process.env["GOOGLE_OAUTH_CLIENT_ID"] = "test-client-id.apps.googleusercontent.com";
  process.env["GOOGLE_OAUTH_CLIENT_SECRET"] = "test-client-secret";
  // The suite drives the per-IP buckets through `X-Forwarded-For`, which the API
  // only honours when an operator says a proxy rewrites it.
  process.env["TRUST_PROXY"] = "1";
  // A25: this is the one suite that wants mail actually delivered, so it runs the
  // real `notify` consumer against the real Redis started above and reads what it
  // wrote. `setup-env.ts` turns the consumer off for every other suite.
  process.env["NOTIFY_WORKER_ENABLED"] = "1";
  process.env["MAIL_PROVIDER"] = "dev";
  resetEnvCache();

  const google = new FakeGoogleProvider();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GOOGLE_OAUTH_PROVIDER)
    .useValue(google)
    .compile();

  // `rawBody` mirrors `main.ts` (A08 signs the internal callbacks over the bytes
  // as sent), so this suite boots the shipped wiring rather than a variant of it.
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  setupOpenApi(app);
  await app.init();

  // A23a: the client the database handed us, rather than a second one of our own.
  // One shared PostgreSQL serves every suite in the run now, and a duplicate pool
  // per suite is connections spent on nothing — `db.stop()` disconnects it.
  const prisma = database.prisma;
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const db = database;

  return {
    app,
    prisma,
    redis,
    google,
    async reset() {
      // Drain before truncating: a notification still in flight would otherwise
      // write its outbox entry into the next test.
      await app.get(NotifyConsumer).drain();
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(", ")} CASCADE`);
      // This suite's namespace, not the whole `montaj:` one. A23a gave each suite
      // a logical Redis database, which held until the package passed sixteen
      // suites and two of them started sharing — at which point this sweep took
      // the sibling's dev-outbox messages with it (A21). A23b made the namespace
      // per-suite, so the sweep is exact again however the databases fall out.
      const authKeys = await redis.keys(`${redisKeyPrefix()}:*`);
      if (authKeys.length > 0) await redis.del(...authKeys);
      google.profiles.clear();
      google.authorizations.length = 0;
      google.exchanges.length = 0;
    },
    async outbox() {
      await app.get(NotifyConsumer).drain();
      const raw = await redis.lrange(redisKeys.devOutbox(), 0, -1);
      return raw.map((entry) => JSON.parse(entry) as OutboxEntry);
    },
    async stop() {
      await app.close();
      await prisma.$disconnect();
      redis.disconnect();
      await db.stop();
    },
  };
}

// ===========================================================================
// B13 — shared admin-session helper for any e2e suite that hits /admin/**
// ===========================================================================

/**
 * A fixed base32 secret, deliberately not random: every suite that calls
 * {@link createAdminContext} enrols the SAME TOTP secret, so the code to
 * verify with is always `currentTotpCode(ADMIN_CONTEXT_TOTP_SECRET)` — one
 * less thing for a suite to thread through its own harness.
 */
const ADMIN_CONTEXT_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

export interface AdminContext {
  readonly userId: string;
  readonly workspaceId: string;
  /** A `kind: "admin"` access token (CONTRACTS §5), minted by a real step-up. */
  readonly accessToken: string;
}

export interface CreateAdminContextOptions {
  readonly app: INestApplication;
  readonly roles: readonly $Enums.AdminRoleName[];
  /** Reuse an existing user/workspace (already seeded by the calling suite) instead of creating new ones. */
  readonly userId?: string;
  readonly workspaceId?: string;
  readonly email?: string;
}

/**
 * Grants `admin_roles`, enrols TOTP with a deterministic secret and performs
 * a real step-up (`AdminStepUpService.verifyEnrollment` then `.stepUp`, the
 * same two calls `POST /admin/auth/totp/verify` and `POST
 * /admin/auth/step-up` make) to hand back a genuine `kind: "admin"` access
 * token — B13's answer to every pre-B13 admin e2e fixture that used to mint
 * a plain `kind: "web"` token for an `is_admin` user, which `AdminGuard` no
 * longer accepts (CONTRACTS §5, amended 2026-09-03).
 *
 * Takes `app: INestApplication` rather than a harness of its own: every e2e
 * suite in this package boots its own Nest application (`auth-harness.ts`,
 * `billing-harness.ts`, or an inline `Test.createTestingModule` as
 * `dlq.e2e-spec.ts` does), so this reaches into whichever one the calling
 * suite already has via `app.get(...)` instead of assuming a particular
 * harness shape.
 */
export async function createAdminContext(
  options: CreateAdminContextOptions,
): Promise<AdminContext> {
  const prisma = options.app.get(PrismaService);
  const stepUp = options.app.get(AdminStepUpService);

  const userId = options.userId ?? ulid();
  const workspaceId = options.workspaceId ?? ulid();

  if (options.userId === undefined) {
    await prisma.user.create({
      data: {
        id: userId,
        email: options.email ?? `admin-ctx-${userId.toLowerCase()}@example.test`,
        isAdmin: true,
      },
    });
  }
  if (options.workspaceId === undefined) {
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `admin-ctx-${workspaceId.toLowerCase()}`,
        name: "Admin context",
        ownerId: userId,
        billingCountry: "IN",
      },
    });
    await prisma.membership.create({
      data: { id: ulid(), workspaceId, userId, role: "owner", status: "active" },
    });
  }

  for (const role of options.roles) {
    await prisma.adminRole.upsert({
      where: { userId_role: { userId, role } },
      create: { id: ulid(), userId, role },
      update: { revokedAt: null },
    });
  }

  // "Enrol" — the deterministic secret, unverified — then verify through the
  // real service, exactly as POST /admin/auth/totp/enroll + /verify would.
  await prisma.adminTotp.upsert({
    where: { userId },
    create: { userId, secret: ADMIN_CONTEXT_TOTP_SECRET },
    update: { secret: ADMIN_CONTEXT_TOTP_SECRET, verifiedAt: null },
  });
  await stepUp.verifyEnrollment(userId, currentTotpCode(ADMIN_CONTEXT_TOTP_SECRET));

  const membership = await prisma.membership.findFirst({ where: { userId, workspaceId } });
  const result = await stepUp.stepUp(
    userId,
    workspaceId,
    membership?.role ?? "owner",
    currentTotpCode(ADMIN_CONTEXT_TOTP_SECRET),
    undefined,
  );

  return { userId, workspaceId, accessToken: result.accessToken };
}
