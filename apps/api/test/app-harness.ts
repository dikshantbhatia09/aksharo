/**
 * A booted Nest application with the real wiring but fake infrastructure.
 *
 * The HTTP e2e suite is about the framework contract — the error envelope, the
 * validation pipe, the health routes, the OpenAPI document — none of which needs
 * a database. `PrismaService` and `RedisService` are therefore overridden, which
 * keeps this suite runnable in a CI lane with no services attached. The suite that
 * DOES need Postgres is `database.e2e-spec.ts`, and it says so by starting one.
 */
import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { setupOpenApi } from "../src/openapi.js";

import type { INestApplication } from "@nestjs/common";

export interface FakeDependencies {
  /** Reject to make the readiness probe report the dependency as down. */
  readonly dbPing?: () => Promise<void>;
  readonly redisPing?: () => Promise<void>;
}

export async function createTestApp(fakes: FakeDependencies = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({
      ping: fakes.dbPing ?? (async () => undefined),
      $connect: async () => undefined,
      $disconnect: async () => undefined,
    })
    .overrideProvider(RedisService)
    .useValue({
      ping: fakes.redisPing ?? (async () => undefined),
      onModuleDestroy: async () => undefined,
    })
    .compile();

  // `logger: false` keeps the deliberate 500-path tests from printing stack
  // traces that read like failures; the assertions cover the behaviour.
  const app = moduleRef.createNestApplication({ logger: false });
  // Same registration as `main.ts`, so the suite tests the shipped wiring.
  app.useGlobalFilters(new HttpExceptionFilter());
  setupOpenApi(app);
  await app.init();
  return app;
}
