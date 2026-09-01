import { Global, Module } from "@nestjs/common";

import { ScheduledTasksService } from "./scheduled-tasks.service.js";

/**
 * The scheduler primitive. `@Global()` so any feature module can inject
 * {@link ScheduledTasksService} and register a periodic task without importing it.
 */
@Global()
@Module({
  providers: [ScheduledTasksService],
  exports: [ScheduledTasksService],
})
export class SchedulerModule {}
