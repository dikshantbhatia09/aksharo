import { Module } from "@nestjs/common";
import { APP_PIPE } from "@nestjs/core";

import { ConfigModule } from "../config/config.module.js";
import { LoggingModule } from "./logging/logging.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { RedisModule } from "./redis/redis.module.js";
import { TelemetryService } from "./telemetry/telemetry.service.js";
import { ZodValidationPipe } from "./validation/zod-validation.pipe.js";

/**
 * Everything a feature module may assume is present: validated configuration,
 * the database, Redis, request-correlated logging and request validation.
 *
 * All four sub-modules are `@Global()`, so importing `CommonModule` once in
 * `AppModule` is enough — feature modules inject `ENV`, `PrismaService` or
 * `RedisService` without importing anything.
 *
 * The exception filter is NOT registered here. It is bound in `main.ts` with
 * `app.useGlobalFilters()` so that it also catches failures raised before the
 * router runs, which an `APP_FILTER` provider does not.
 */
@Module({
  imports: [ConfigModule, LoggingModule, PrismaModule, RedisModule],
  providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }, TelemetryService],
  exports: [ConfigModule, LoggingModule, PrismaModule, RedisModule],
})
export class CommonModule {}
