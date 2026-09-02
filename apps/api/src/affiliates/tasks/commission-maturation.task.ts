import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { PayoutsService } from "../payouts/payouts.service.js";

export const COMMISSION_MATURATION_TASK = "affiliates.commission-maturation";

/** Daily: the 30-day maturation hold is a specific instant, checked cheaply once a day. */
const COMMISSION_MATURATION_CRON = "15 2 * * *";

/**
 * Moves `pending` commissions whose `availableAt` has passed to `payable`
 * (brief §3: "pending with `availableAt = paidAt + 30 d`"). Registers with
 * `ScheduledTasksService` (`common/scheduler/README` pattern, B16 wires the
 * actual cron trigger in production); `runNow` is the test/manual seam.
 */
@Injectable()
export class CommissionMaturationTask implements OnModuleInit {
  private readonly logger = new Logger(CommissionMaturationTask.name);

  constructor(
    private readonly payouts: PayoutsService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: COMMISSION_MATURATION_TASK,
      cron: COMMISSION_MATURATION_CRON,
      run: async ({ at }) => {
        const matured = await this.payouts.matureCommissions(at);
        if (matured > 0) this.logger.log({ matured }, "commissions matured");
      },
    });
  }
}
