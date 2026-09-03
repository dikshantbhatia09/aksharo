/**
 * `pnpm gen:client` — regenerate `@montaj/api-client` from the OpenAPI document.
 *
 * The document is the contract (10-build-plan section 2), so it is produced by the
 * shipped wiring rather than written by hand: the script boots the real
 * `AppModule` with Prisma and Redis substituted, asks `SwaggerModule` for the
 * document `/docs-json` would serve, and writes two artefacts:
 *
 *   * `packages/api-client/openapi.json`            — the spec itself.
 *   * `packages/api-client/src/generated/operations.ts` — a typed index of every
 *     operation, so a consumer gets a compile error when a route it calls is
 *     renamed or removed, without waiting for A13's generated hooks.
 *
 * Substituting the two infrastructure providers is what keeps this runnable with
 * no `docker compose` up: building a document needs the route table, not a
 * database.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { openApiDocumentConfig } from "../src/openapi.js";
import {
  InMemoryRealtimeBroker,
  InMemoryRealtimeBus,
  REALTIME_BUS,
} from "../src/realtime/realtime.bus.js";

/**
 * `pnpm run` sets the working directory to the package root, and the compiled
 * copy of this file lives under `.openapi/`, so `__dirname` is the wrong anchor.
 */
const API_DIR = process.cwd();
const CLIENT_DIR = resolve(API_DIR, "../../packages/api-client");
const SPEC_PATH = resolve(CLIENT_DIR, "openapi.json");
const OPERATIONS_PATH = resolve(CLIENT_DIR, "src/generated/operations.ts");

/**
 * Codegen must not depend on a developer's `.env`.
 *
 * `loadEnv()` is fail-fast by design, so the script supplies the contract set with
 * obviously-local placeholders when a variable is absent. Nothing here is a
 * secret and nothing connects anywhere.
 */
const PLACEHOLDER_ENV: Record<string, string> = {
  NODE_ENV: "development",
  // A08: without this the scheduler starts a BullMQ worker that blocks on Redis
  // and the generator never exits.
  MONTAJ_SCHEDULER_DISABLED: "1",
  MONTAJ_QUEUE_PREFIX: "montaj-gen-client",
  // A25: same reason — the notify consumer's `Worker` would block on Redis.
  NOTIFY_WORKER_ENABLED: "0",
  MAIL_PROVIDER: "dev",
  DATABASE_URL: "postgresql://localhost:5432/unused?schema=public",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "ap-south-1",
  S3_BUCKET_RAW: "unused",
  S3_ACCESS_KEY: "unused",
  S3_SECRET_KEY: "unused",
  R2_ENDPOINT: "http://localhost:9000",
  R2_BUCKET_DERIVED: "unused",
  R2_ACCESS_KEY: "unused",
  R2_SECRET_KEY: "unused",
  JWT_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\\nnot-used-for-codegen\\n-----END PRIVATE KEY-----\\n",
  JWT_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\\nnot-used-for-codegen\\n-----END PUBLIC KEY-----\\n",
  INTERNAL_CALLBACK_SECRET: "codegen-placeholder-at-least-32-characters",
  WEB_ORIGIN: "http://localhost:3000",
  API_ORIGIN: "http://localhost:3001",
  LLM_PROVIDER: "mock",
  GPU_PROVIDER: "none",
  FEATURE_FLAGS_JSON: "{}",
};

interface Operation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary: string;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

function collectOperations(document: Record<string, unknown>): Operation[] {
  const paths = (document["paths"] ?? {}) as Record<string, Record<string, unknown>>;
  const operations: Operation[] = [];

  for (const [path, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      const operation = item[method] as
        { operationId?: string; tags?: string[]; summary?: string } | undefined;
      if (operation === undefined) continue;
      operations.push({
        operationId: operation.operationId ?? `${method}_${path}`,
        method: method.toUpperCase(),
        path,
        tags: operation.tags ?? [],
        summary: operation.summary ?? "",
      });
    }
  }

  return operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
}

function renderOperations(operations: readonly Operation[], version: string): string {
  const entries = operations
    .map(
      (operation) =>
        `  {\n` +
        `    operationId: ${JSON.stringify(operation.operationId)},\n` +
        `    method: ${JSON.stringify(operation.method)},\n` +
        `    path: ${JSON.stringify(operation.path)},\n` +
        `    tags: ${JSON.stringify(operation.tags)},\n` +
        `    summary: ${JSON.stringify(operation.summary)},\n` +
        `  },`,
    )
    .join("\n");

  return `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by \`pnpm gen:client\` from the API's OpenAPI document. The full spec is
 * \`openapi.json\` beside this package's manifest; this module is the part a
 * consumer can hold a compile-time reference to.
 */

export interface ApiOperation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary: string;
}

/** Version of the API the document was generated from. */
export const API_VERSION = ${JSON.stringify(version)};

export const API_OPERATIONS = [
${entries}
] as const satisfies readonly ApiOperation[];

/** Every operation id in the document, as a union. */
export type ApiOperationId = (typeof API_OPERATIONS)[number]["operationId"];

/** Look one up by id. */
export function findOperation(operationId: ApiOperationId): ApiOperation | undefined {
  return API_OPERATIONS.find((operation) => operation.operationId === operationId);
}
`;
}

/** Enough of `RedisService` for the module graph to construct; nothing dials out. */
function fakeRedis() {
  const client = {
    status: "ready" as const,
    on: () => client,
    publish: async () => 1,
    subscribe: async () => 1,
    unsubscribe: async () => 1,
    duplicate: () => client,
    disconnect: () => undefined,
    quit: async () => "OK",
    ping: async () => "PONG",
  };
  return {
    client,
    ping: async (): Promise<void> => undefined,
    onModuleDestroy: async (): Promise<void> => undefined,
  };
}

async function main(): Promise<void> {
  if (!existsSync(resolve(API_DIR, "prisma/schema.prisma"))) {
    throw new Error(`run this from apps/api (cwd is ${API_DIR})`);
  }

  for (const [name, value] of Object.entries(PLACEHOLDER_ENV)) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    process.env[name] ??= value;
  }

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({ $connect: async () => undefined, $disconnect: async () => undefined })
    .overrideProvider(RedisService)
    .useValue(fakeRedis())
    // A08's gateway would otherwise open a real pub/sub connection.
    .overrideProvider(REALTIME_BUS)
    .useValue(new InMemoryRealtimeBus(new InMemoryRealtimeBroker()))
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();

  const document = SwaggerModule.createDocument(app, openApiDocumentConfig()) as unknown as Record<
    string,
    unknown
  >;
  await app.close();

  const operations = collectOperations(document);
  const version = String(
    (document["info"] as { version?: string } | undefined)?.version ?? "0.0.0",
  );

  mkdirSync(dirname(OPERATIONS_PATH), { recursive: true });
  writeFileSync(SPEC_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  writeFileSync(OPERATIONS_PATH, renderOperations(operations, version), "utf8");

  console.warn(
    `[gen:client] ${String(operations.length)} operations -> ` +
      `packages/api-client (openapi.json, src/generated/operations.ts)`,
  );

  // The files are written; a queue client or a socket that outlived `app.close()`
  // must not keep a codegen step alive.
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
