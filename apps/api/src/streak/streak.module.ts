import { Module } from "@nestjs/common";

import { STREAK_DISCOUNT_PROVIDER } from "./streak-discount.port.js";
import { StreakDiscountService } from "./streak-discount.service.js";
import { StreakNudgeTask } from "./streak-nudge.task.js";
import { StreakRolloverTask } from "./streak-rollover.task.js";
import { StreakController } from "./streak.controller.js";
import { StreakService } from "./streak.service.js";
import { NotifyModule } from "../notify/notify.module.js";

/**
 * The streak experiment (B06): assignment, `GET /streak`, the weekly
 * rollover and Tuesday-nudge tasks, and `StreakDiscountService` — the
 * concrete adapter `app.module.ts` binds `STREAK_DISCOUNT_PROVIDER` to so
 * `billing/`'s `RenewalService` can read a discount percent without
 * depending on this module directly.
 *
 * `CreditsFacade` (`CREDITS_FACADE`) and `PrismaService` come from their own
 * `@Global()` modules, exactly like every other feature module in this
 * codebase; only `NotifyModule` needs an explicit import here.
 */
@Module({
  imports: [NotifyModule],
  controllers: [StreakController],
  providers: [
    StreakService,
    StreakDiscountService,
    StreakRolloverTask,
    StreakNudgeTask,
    { provide: STREAK_DISCOUNT_PROVIDER, useExisting: StreakDiscountService },
  ],
  exports: [StreakService, StreakDiscountService, STREAK_DISCOUNT_PROVIDER],
})
export class StreakModule {}
