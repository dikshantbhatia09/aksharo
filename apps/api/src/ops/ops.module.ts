import { Module } from "@nestjs/common";

import { OpsIncidentsService } from "./ops-incidents.service.js";
import { StatusController } from "./status.controller.js";
import { HealthModule } from "../health/health.module.js";

/**
 * X04: `ops_incidents` (the public status-page incident list) and the public
 * `status.json`/RSS surface. `OpsIncidentsService` is exported so
 * `AdminModule`'s `AdminOpsController` (B13's admin console, added alongside
 * B13b/B16's existing controllers, not refactored) and
 * `SchedulerTasksModule`'s `StatusPublishTask` can both reach it without a
 * second provider.
 */
@Module({
  imports: [HealthModule],
  controllers: [StatusController],
  providers: [OpsIncidentsService],
  exports: [OpsIncidentsService],
})
export class OpsModule {}
