import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { RepurposeService } from "./repurpose.service.js";
import { ScheduledTasksService } from "../common/scheduler/scheduled-tasks.service.js";

export const REPURPOSE_STUCK_RUNS_SWEEP_TASK = "repurpose.stuck-runs-sweep";
export const REPURPOSE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Scheduled sweep for stuck repurpose runs (CORE-023).
 *
 * Runs periodically to find any in-flight repurpose run that has exceeded its
 * per-stage deadline, moves it to a terminal failed state with a customer-readable
 * reason, and releases any credit hold the run owns.
 */
@Injectable()
export class RepurposeStuckRunsSweepTask implements OnModuleInit {
  private readonly logger = new Logger(RepurposeStuckRunsSweepTask.name);

  constructor(
    private readonly repurpose: RepurposeService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: REPURPOSE_STUCK_RUNS_SWEEP_TASK,
      everyMs: REPURPOSE_SWEEP_INTERVAL_MS,
      run: async ({ at }) => {
        const report = await this.sweep(at);
        if (report.failedRuns.length > 0) {
          this.logger.log(report, "stuck repurpose runs swept");
        }
      },
    });
  }

  async sweep(now: Date = new Date()) {
    return this.repurpose.sweepStuckRuns(now);
  }
}
