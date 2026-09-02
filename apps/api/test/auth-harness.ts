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
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

import { createTestDatabase } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { AppModule } from "../src/app.module.js";
import { redisKeys } from "../src/auth/auth.constants.js";
import { GOOGLE_OAUTH_PROVIDER } from "../src/auth/google-oauth.provider.js";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter.js";
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

  const prisma = new PrismaClient({ datasources: { db: { url: database.url } } });
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
      // Safe to sweep the whole `montaj:` namespace: A23a gives this suite its own
      // logical Redis database, so nothing else in the run has keys in here.
      const authKeys = await redis.keys("montaj:*");
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
