import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { RetentionService } from "../../media/retention.service.js";

/** The scheduled task's name; also its BullMQ scheduler key. */
export const MEDIA_RETENTION_TASK = "scheduler.media-retention";

/** Hourly (06-data-model.md §Retention jobs: "Hourly: purge raw media past rawPurgeAt"). */
const MEDIA_RETENTION_CRON = "5 * * * *";

/**
 * Wires `RetentionService.purgeDueMedia()` (A06) into the scheduler.
 *
 * The service does the actual work — object deletes then row updates, batched,
 * idempotent by construction (`rawPurgedAt`/`derivedPurgedAt` gate every row) —
 * and deliberately registers no schedule of its own; A06's module doc says why:
 * "B16 owns the scheduler wiring". This is that wiring, for both of its clocks
 * (`raw_purge_at` hourly-fine, `derived_purge_at` the same pass — cheap enough
 * to share one tick rather than run two).
 */
@Injectable()
export class MediaRetentionTask implements OnModuleInit {
  private readonly logger = new Logger(MediaRetentionTask.name);

  constructor(
    private readonly retention: RetentionService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: MEDIA_RETENTION_TASK,
      cron: MEDIA_RETENTION_CRON,
      run: async ({ at }) => {
        const report = await this.retention.purgeDueMedia({ now: at });
        if (report.rawPurged > 0 || report.derivedPurged > 0 || report.failed > 0) {
          this.logger.log(report, "media retention swept");
        }
      },
    });
  }
}
