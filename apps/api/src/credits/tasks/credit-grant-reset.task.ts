import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { LedgerCreditsFacade } from "../ledger-credits.facade.js";

export const CREDIT_GRANT_RESET_TASK = "credits.grant-reset";

/** Every 15 minutes: `grantResetAt` is a specific instant, not a calendar day. */
const CREDIT_GRANT_RESET_CRON = "*/15 * * * *";

/**
 * Grants the monthly allowance to every account whose `credit_accounts.grant_reset_at`
 * has passed (D32 §Grants: "monthly grant on the billing anniversary").
 *
 * Plan-change proration ("upgrade: grant the difference immediately; downgrade:
 * at period end") is not this task's concern — it reacts to a subscription
 * event and is one `grantLot` call from wherever that event is handled (B01).
 * This is only the recurring anniversary tick, and it is safe to fire twice for
 * the same account (`LedgerCreditsFacade.resetMonthlyGrants`'s own conditional
 * claim on `grantResetAt` is what makes that true).
 */
@Injectable()
export class CreditGrantResetTask implements OnModuleInit {
  private readonly logger = new Logger(CreditGrantResetTask.name);

  constructor(
    private readonly credits: LedgerCreditsFacade,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: CREDIT_GRANT_RESET_TASK,
      cron: CREDIT_GRANT_RESET_CRON,
      run: async ({ at }) => {
        const result = await this.credits.resetMonthlyGrants(at);
        if (result.accountsReset > 0) {
          this.logger.log(result, "monthly credit grants reset");
        }
      },
    });
  }
}
