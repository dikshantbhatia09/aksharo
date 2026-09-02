import { Module } from "@nestjs/common";

import { AdmissionService } from "./admission.service.js";
import { JobCompletionRegistry } from "./completion-handlers.js";
import { DlqService } from "./dlq.service.js";
import { JobEventsService } from "./job-events.service.js";
import { JobsController } from "./jobs.controller.js";
import { JobsService } from "./jobs.service.js";
import { QueueRegistry } from "./queue.registry.js";
import { DlqDepthTask } from "./tasks/dlq-depth.task.js";
import { JobEventRetentionTask } from "./tasks/job-event-retention.task.js";
import { QueueTimeoutTask } from "./tasks/queue-timeout.task.js";

/**
 * Jobs: the producer side of every CONTRACTS §3 queue, the `jobs`/`job_events`
 * state machine, admission control, the dead-letter queue and three scheduled
 * sweeps (queue timeout, job-event retention, dead-letter depth).
 *
 * Nothing is imported: `PrismaService`, `RedisService`, `ENV`,
 * `ScheduledTasksService`, `MetricsService`, `RealtimePublisher` and
 * `CREDITS_FACADE` all come from global modules. `JobsService` is exported because
 * every other feature module is a producer — A06/A07 media, A09/A11 ai, A20/A21
 * render and export — and `DlqService` because `AdminModule` drives it.
 *
 * `JobCompletionRegistry` is exported for the other half of that relationship: a
 * producer also owns what its completions *mean*, and registers a handler here at
 * boot (A07's `media.probe` is the first).
 */
@Module({
  controllers: [JobsController],
  providers: [
    JobsService,
    JobCompletionRegistry,
    DlqService,
    QueueRegistry,
    AdmissionService,
    JobEventsService,
    QueueTimeoutTask,
    JobEventRetentionTask,
    DlqDepthTask,
  ],
  exports: [
    JobsService,
    JobCompletionRegistry,
    DlqService,
    QueueRegistry,
    JobEventsService,
    QueueTimeoutTask,
    JobEventRetentionTask,
    DlqDepthTask,
  ],
})
export class JobsModule {}
