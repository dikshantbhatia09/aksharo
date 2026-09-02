import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { PayoutsService } from "../payouts/payouts.service.js";

export const PAYOUT_BATCH_TASK = "affiliates.payout-batch";

/** Monthly, 1st at 03:00 — after the nightly maturation sweep has had a chance to run. */
const PAYOUT_BATCH_CRON = "0 3 1 * *";

/**
 * Monthly affiliate payout batching (brief §5). Registers with
 * `ScheduledTasksService`; B16 wires the production trigger, this work
 * package only implements the task body. `runNow` (via `ScheduledTasksService
 * .runNow`) is the test/manual seam — the acceptance e2e drives it directly
 * rather than waiting for a real month to pass.
 */
@Injectable()
export class PayoutBatchTask implements OnModuleInit {
  private readonly logger = new Logger(PayoutBatchTask.name);

  constructor(
    private readonly payouts: PayoutsService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: PAYOUT_BATCH_TASK,
      cron: PAYOUT_BATCH_CRON,
      run: async () => {
        const result = await this.payouts.runMonthlyBatch();
        this.logger.log(result, "monthly affiliate payout batch");
      },
    });
  }
}
