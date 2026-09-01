/**
 * A booted API with a real PostgreSQL, a real Redis and a fake Google.
 *
 * Auth is the one module that cannot be tested against substituted
 * infrastructure: refresh families are a database invariant, the rotation grace is
 * a Redis entry, the device-grant poll interval is a Redis `SET NX`, and the point
 * of the tests is that those actually hold. So the suite starts both services
 * (testcontainers, or `TEST_DATABASE_URL` / `TEST_REDIS_URL` when CI already
 * provides them) and skips loudly when Docker is unavailable, exactly as
 * `database.e2e-spec.ts` does.
 *
 * Google is the exception: the identity provider is a third party, so it is
 * substituted through the `GOOGLE_OAUTH_PROVIDER` port.
 */
import { generateKeyPairSync } from "node:crypto";

import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

import { createTestDatabase } from "./db-harness.js";
import { AppModule } from "../src/app.module.js";
import { redisKeys } from "../src/auth/auth.constants.js";
import { GOOGLE_OAUTH_PROVIDER } from "../src/auth/google-oauth.provider.js";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter.js";
import { resetEnvCache } from "../src/config/config.module.js";
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

export interface AuthTestContext {
  readonly app: INestApplication;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly google: FakeGoogleProvider;
  /** Empty every table auth touches and every auth key in Redis. */
  reset(): Promise<void>;
  /** The development mail outbox, newest first. */
  outbox(): Promise<{ to: string; template: string; token?: string; link: string }[]>;
  stop(): Promise<void>;
}

/** Why the suite was skipped, for the console message. */
export let authSkipReason = "";

const REDIS_IMAGE = "redis:7-alpine";

interface RedisHandle {
  url: string;
  stop(): Promise<void>;
}

async function startRedis(): Promise<RedisHandle> {
  const fromEnv = process.env["TEST_REDIS_URL"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return { url: fromEnv, stop: async () => undefined };
  }

  const { GenericContainer } = await import("testcontainers");
  const container = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    .withStartupTimeout(120_000)
    .start();

  return {
    url: `redis://${container.getHost()}:${String(container.getMappedPort(6379))}`,
    stop: async () => {
      await container.stop();
    },
  };
}

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
  "audit_log",
  "access_logs",
  "consent_records",
  "device_codes",
  "sessions",
  "identities",
  "memberships",
  "api_keys",
  "workspaces",
  "users",
];

export async function createAuthTestContext(): Promise<AuthTestContext | null> {
  let database: TestDatabase | null = null;
  let redisHandle: RedisHandle | undefined;

  try {
    database = await createTestDatabase();
    if (database === null) {
      authSkipReason = "no test database";
      return null;
    }
    redisHandle = await startRedis();
  } catch (error) {
    authSkipReason = error instanceof Error ? error.message : String(error);
    if (database !== null) await database.stop();
    return null;
  }

  const keys = generateJwtKeys();
  process.env["DATABASE_URL"] = database.url;
  process.env["REDIS_URL"] = redisHandle.url;
  process.env["JWT_PRIVATE_KEY"] = keys.privateKey;
  process.env["JWT_PUBLIC_KEY"] = keys.publicKey;
  process.env["GOOGLE_OAUTH_CLIENT_ID"] = "test-client-id.apps.googleusercontent.com";
  process.env["GOOGLE_OAUTH_CLIENT_SECRET"] = "test-client-secret";
  // The suite drives the per-IP buckets through `X-Forwarded-For`, which the API
  // only honours when an operator says a proxy rewrites it.
  process.env["TRUST_PROXY"] = "1";
  resetEnvCache();

  const google = new FakeGoogleProvider();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GOOGLE_OAUTH_PROVIDER)
    .useValue(google)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new HttpExceptionFilter());
  setupOpenApi(app);
  await app.init();

  const prisma = new PrismaClient({ datasources: { db: { url: database.url } } });
  const redis = new Redis(redisHandle.url, { maxRetriesPerRequest: null });
  const db = database;
  const redisRef = redisHandle;

  return {
    app,
    prisma,
    redis,
    google,
    async reset() {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.join(", ")} CASCADE`);
      const authKeys = await redis.keys("montaj:*");
      if (authKeys.length > 0) await redis.del(...authKeys);
      google.profiles.clear();
      google.authorizations.length = 0;
      google.exchanges.length = 0;
    },
    async outbox() {
      const raw = await redis.lrange(redisKeys.devOutbox(), 0, -1);
      return raw.map(
        (entry) =>
          JSON.parse(entry) as { to: string; template: string; token?: string; link: string },
      );
    },
    async stop() {
      await app.close();
      await prisma.$disconnect();
      redis.disconnect();
      await redisRef.stop();
      await db.stop();
    },
  };
}
