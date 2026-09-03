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
  // X04's `OpsModule` reuses the same db/redis/storage probes for the public
  // status snapshot rather than re-implementing them.
  exports: [HealthService],
})
export class HealthModule {}
