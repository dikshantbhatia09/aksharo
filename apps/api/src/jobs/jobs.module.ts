import { Module } from "@nestjs/common";

import { AdmissionService } from "./admission.service.js";
import { JobEventsService } from "./job-events.service.js";
import { JobsController } from "./jobs.controller.js";
import { JobsService } from "./jobs.service.js";
import { QueueRegistry } from "./queue.registry.js";
import { QueueTimeoutTask } from "./tasks/queue-timeout.task.js";

/**
 * Jobs: the producer side of every CONTRACTS §3 queue, the `jobs`/`job_events`
 * state machine, admission control and the queue-timeout sweeper.
 *
 * Nothing is imported: `PrismaService`, `RedisService`, `ENV`,
 * `ScheduledTasksService`, `RealtimePublisher` and `CREDITS_FACADE` all come from
 * global modules. `JobsService` is exported because every other feature module is
 * a producer — A06/A07 media, A09/A11 ai, A20/A21 render and export.
 */
@Module({
  controllers: [JobsController],
  providers: [JobsService, QueueRegistry, AdmissionService, JobEventsService, QueueTimeoutTask],
  exports: [JobsService, QueueRegistry, JobEventsService, QueueTimeoutTask],
})
export class JobsModule {}
