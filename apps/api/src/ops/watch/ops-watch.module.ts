import { Module, type Provider } from "@nestjs/common";

import { ALERT_SENDER_OPTIONS, AlertSender, alertSenderOptions } from "./alert-sender.js";
import { AlertStateStore } from "./alert-state.js";
import { DISK_PROBE, OpsWatchChecks, defaultDiskProbe } from "./ops-watch.checks.js";
import { OpsWatchTask } from "./ops-watch.task.js";
import { JobsModule } from "../../jobs/jobs.module.js";
import { LeaseReaperTask } from "../../jobs/lease-reaper.task.js";

/** Exported so a unit test can prove the graph resolves without booting `JobsModule`. */
export const OPS_WATCH_PROVIDERS: Provider[] = [
  { provide: ALERT_SENDER_OPTIONS, useFactory: alertSenderOptions },
  { provide: DISK_PROBE, useFactory: defaultDiskProbe },
  AlertSender,
  AlertStateStore,
  OpsWatchChecks,
  OpsWatchTask,
  LeaseReaperTask,
];

/**
 * Operations watch (2026-09-27): the `ops.watch` alerts and the `jobs.lease-reaper`
 * that fails the zombie jobs they would otherwise keep reporting.
 *
 * Both are scheduled tasks and run only where the scheduler runs: production
 * sets `MONTAJ_SCHEDULER_DISABLED=0` and lists them in `MONTAJ_SCHEDULER_TASKS`,
 * which keeps every other task off; `MONTAJ_SCHEDULER_DISABLED=1` stops them all
 * (`common/scheduler/scheduler.types.ts`). The reaper is a jobs concern and its
 * code lives in `jobs/`; it is provided here, beside the watch that reports what
 * it cannot fix, so that turning operations on is one module in `AppModule`
 * rather than an edit to `JobsModule`, which every producer depends on.
 *
 * `PrismaService`, `RedisService` and `ScheduledTasksService` are global;
 * `JobsModule` supplies `JobsService` and `QueueRegistry`.
 */
@Module({
  imports: [JobsModule],
  providers: [...OPS_WATCH_PROVIDERS],
})
export class OpsWatchModule {}
