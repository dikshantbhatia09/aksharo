import { Global, Module } from "@nestjs/common";

import { MetricsController } from "./metrics.controller.js";
import { MetricsService } from "./metrics.service.js";

/**
 * Application metrics. `@Global()` so any feature module can inject
 * {@link MetricsService} and record a counter without importing anything, in the
 * same shape as `PrismaModule` and `SchedulerModule`.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
