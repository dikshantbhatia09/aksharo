/**
 * A booted Nest application with the real wiring but fake infrastructure.
 *
 * The HTTP e2e suite is about the framework contract — the error envelope, the
 * validation pipe, the health routes, the OpenAPI document — none of which needs
 * a database. `PrismaService` and `RedisService` are therefore overridden, which
 * keeps this suite runnable in a CI lane with no services attached. The suite that
 * DOES need Postgres is `database.e2e-spec.ts`, and it says so by starting one.
 *
 * A08 added two more substitutions for the same reason: `REALTIME_BUS` becomes an
 * in-memory broker so the gateway has something to subscribe to, and the scheduler
 * is off via `MONTAJ_SCHEDULER_DISABLED` in `setup-env.ts`. Everything else — the
 * jobs module, the guards, the internal routes — is the shipped wiring.
 */
import { Test } from "@nestjs/testing";

import { createFakeRedis } from "./fakes.js";
import { AppModule } from "../src/app.module.js";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { setupOpenApi } from "../src/openapi.js";
import {
  InMemoryRealtimeBroker,
  InMemoryRealtimeBus,
  REALTIME_BUS,
} from "../src/realtime/realtime.bus.js";

import type { INestApplication } from "@nestjs/common";

export interface FakeDependencies {
  /** Reject to make the readiness probe report the dependency as down. */
  readonly dbPing?: () => Promise<void>;
  readonly redisPing?: () => Promise<void>;
  /** Extra Prisma methods a suite needs; merged over the default stub. */
  readonly prisma?: Record<string, unknown>;
  /** Replace the Redis client with one that actually stores (A25's suppression). */
  readonly redisClient?: unknown;
  /** Share one broker between two apps to exercise cross-instance fan-out. */
  readonly broker?: InMemoryRealtimeBroker;
  /**
   * Extra provider substitutions, `[token, value]`.
   *
   * A25 added it for the SNS certificate fetcher: the mail-events route is
   * authenticated by a signature over a certificate fetched from AWS, and a
   * suite that boots the HTTP layer has to hand it a fixture instead.
   */
  readonly overrides?: readonly (readonly [unknown, unknown])[];
}

export async function createTestApp(fakes: FakeDependencies = {}): Promise<INestApplication> {
  const redis = createFakeRedis();

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({
      ping: fakes.dbPing ?? (async () => undefined),
      $connect: async () => undefined,
      $disconnect: async () => undefined,
      ...(fakes.prisma ?? {}),
    })
    .overrideProvider(RedisService)
    .useValue({
      ...redis,
      ...(fakes.redisClient === undefined ? {} : { client: fakes.redisClient }),
      ping: fakes.redisPing ?? redis.ping,
    })
    .overrideProvider(REALTIME_BUS)
    .useValue(new InMemoryRealtimeBus(fakes.broker ?? new InMemoryRealtimeBroker()));

  for (const [token, value] of fakes.overrides ?? []) {
    builder.overrideProvider(token as never).useValue(value);
  }

  const moduleRef = await builder.compile();

  // `logger: false` keeps the deliberate 500-path tests from printing stack
  // traces that read like failures; the assertions cover the behaviour.
  // `rawBody: true` mirrors `main.ts`: the internal callbacks are HMAC'd over the
  // bytes as sent, so the guard needs `req.rawBody`.
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  // Same registration as `main.ts`, so the suite tests the shipped wiring.
  app.useGlobalFilters(new HttpExceptionFilter());
  setupOpenApi(app);
  await app.init();
  return app;
}
