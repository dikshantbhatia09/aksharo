import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { StreakService } from "./streak.service.js";
import { PrismaService } from "../common/index.js";
import { ScheduledTasksService } from "../common/scheduler/scheduled-tasks.service.js";

export const STREAK_ROLLOVER_TASK = "streak.weekly-rollover";

/** Hourly — cheap (an idempotent no-op for every row not yet past its window end) and
 * catches every workspace's own Mon-Sun boundary regardless of timezone. */
const STREAK_ROLLOVER_CRON = "0 * * * *";

/**
 * Weekly rollover: closes out the week every streak-experiment row is
 * tracking once its window has actually elapsed, and applies that week's
 * transition (kept / froze / paused / resumed / leveled up) plus any reward
 * it triggers (B06 brief §2). Registered by this module itself, the same
 * self-registering pattern every other periodic task in this codebase uses
 * (`credits/tasks/credit-grant-reset.task.ts`).
 */
@Injectable()
export class StreakRolloverTask implements OnModuleInit {
  private readonly logger = new Logger(StreakRolloverTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly streak: StreakService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: STREAK_ROLLOVER_TASK,
      cron: STREAK_ROLLOVER_CRON,
      run: async ({ at }) => {
        const touched = await this.runNow(at);
        if (touched > 0) this.logger.log({ touched }, "streak weekly rollover");
      },
    });
  }

  /** Exposed for the scheduler's own `runNow` test seam and for tests here. */
  async runNow(now: Date = new Date()): Promise<number> {
    const rows = await this.prisma.streakExperiment.findMany({ select: { workspaceId: true } });
    for (const row of rows) {
      await this.streak.rolloverOne(row.workspaceId, now);
    }
    return rows.length;
  }
}
