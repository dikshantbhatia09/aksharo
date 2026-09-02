import { Global, Module } from "@nestjs/common";

import { CreditOrphanedHoldsService } from "./credit-orphaned-holds.service.js";
import { CreditReconcileService } from "./credit-reconcile.service.js";
import { CreditsLowBalanceNotifier } from "./credits-low-balance.notifier.js";
import { CreditsQueryService } from "./credits-query.service.js";
import { CreditsController } from "./credits.controller.js";
import { CREDITS_FACADE } from "./credits.facade.js";
import { LedgerCreditsFacade } from "./ledger-credits.facade.js";
import { NoopCreditsFacade } from "./noop-credits.facade.js";
import { CreditGrantResetTask } from "./tasks/credit-grant-reset.task.js";
import { CreditLotExpiryTask } from "./tasks/credit-lot-expiry.task.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Binds {@link CREDITS_FACADE} to {@link LedgerCreditsFacade} (D32, RR-09b P0-4):
 * the ledger-backed implementation of the frozen `CreditsFacade` interface
 * (CONTRACTS §4), replacing A08's {@link NoopCreditsFacade}.
 *
 * `@Global()` for the same reason A08 made it global: every job producer needs
 * `CREDITS_FACADE` and none of them should have to import a credits module to
 * get it. `NoopCreditsFacade` stays registered and exported — the brief keeps it
 * "for unit tests" that want an in-memory double rather than a database.
 *
 * `LedgerCreditsFacade` is also exported as a class, alongside the surface that
 * lives beyond the frozen interface (`reverse`, `expireLots`,
 * `resetMonthlyGrants`) — B13 (admin refunds) and B01 (payment refunds) inject
 * the concrete class for those, exactly as `NoopCreditsFacade` was exported for
 * its `holdStatus()`/`reset()` test hooks.
 *
 * Imports `WorkspacesModule` for `CreditsController`'s `WorkspaceMemberGuard`
 * (THREAT-MODEL T4) — re-exported from there since A05 registered it as a
 * module-local provider.
 */
@Global()
@Module({
  imports: [WorkspacesModule],
  controllers: [CreditsController],
  providers: [
    NoopCreditsFacade,
    LedgerCreditsFacade,
    CreditsLowBalanceNotifier,
    CreditsQueryService,
    CreditReconcileService,
    CreditOrphanedHoldsService,
    CreditLotExpiryTask,
    CreditGrantResetTask,
    { provide: CREDITS_FACADE, useExisting: LedgerCreditsFacade },
  ],
  exports: [
    CREDITS_FACADE,
    NoopCreditsFacade,
    LedgerCreditsFacade,
    CreditsQueryService,
    CreditReconcileService,
    CreditOrphanedHoldsService,
  ],
})
export class CreditsModule {}
