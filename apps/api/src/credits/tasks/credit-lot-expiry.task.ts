import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { LedgerCreditsFacade } from "../ledger-credits.facade.js";

export const CREDIT_LOT_EXPIRY_TASK = "credits.lot-expiry";

/** Once an hour: a lot that just crossed `expiresAt` should not stay spendable all day. */
const CREDIT_LOT_EXPIRY_CRON = "15 * * * *";

/**
 * Sweeps `credit_lots` whose `expiresAt` has passed into an `expire` ledger
 * entry (D32, `06-data-model.md` §Retention jobs: "Daily: … grant resets and lot
 * expiry" — run hourly here because a monthly grant is small enough, and a
 * workspace's window to notice a stale balance short enough, that a day's delay
 * is worse than the extra scans).
 */
@Injectable()
export class CreditLotExpiryTask implements OnModuleInit {
  private readonly logger = new Logger(CreditLotExpiryTask.name);

  constructor(
    private readonly credits: LedgerCreditsFacade,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: CREDIT_LOT_EXPIRY_TASK,
      cron: CREDIT_LOT_EXPIRY_CRON,
      run: async ({ at }) => {
        const result = await this.credits.expireLots(at);
        if (result.lotsExpired > 0) {
          this.logger.log(result, "credit lots expired");
        }
      },
    });
  }
}
