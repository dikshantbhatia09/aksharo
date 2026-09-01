import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

/**
 * `PrismaService`, `RedisService` and `ENV` all come from global modules
 * (`PrismaModule`, `RedisModule`, `ConfigModule`), so nothing is imported here.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
