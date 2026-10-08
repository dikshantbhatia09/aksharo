import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { MEDIA_STALE_REAPER_TASK, STALE_MEDIA_REAPER_CRON } from "./media.constants.js";
import { StaleMediaReaperService } from "./stale-media-reaper.service.js";
import { ScheduledTasksService } from "../common/scheduler/scheduled-tasks.service.js";

/**
 * Scheduled reaper task for stale media assets (CORE-016).
 */
@Injectable()
export class StaleMediaReaperTask implements OnModuleInit {
  private readonly logger = new Logger(StaleMediaReaperTask.name);

  constructor(
    private readonly reaper: StaleMediaReaperService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: MEDIA_STALE_REAPER_TASK,
      cron: STALE_MEDIA_REAPER_CRON,
      run: async ({ at }) => {
        const report = await this.sweep(at);
        if (report.reaped > 0 || report.abortedUploads > 0) {
          this.logger.log(report, "stale media assets reaped");
        }
      },
    });
  }

  async sweep(now: Date = new Date()) {
    return this.reaper.reapStaleMedia({ now });
  }
}
