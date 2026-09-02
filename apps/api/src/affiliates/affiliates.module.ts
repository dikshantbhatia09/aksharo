import { Module } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { AffiliatesController } from "./affiliates.controller.js";
import { AffiliatesService } from "./affiliates.service.js";
import { AttributionService } from "./attribution.service.js";
import { AffiliateCodeService } from "./code.service.js";
import { CommissionService } from "./commission.service.js";
import { FraudService } from "./fraud.service.js";
import { InvoiceEventsListener } from "./listeners/invoice-events.listener.js";
import { PAYOUT_PROVIDER } from "./payouts/payout-provider.js";
import { createPayoutProvider } from "./payouts/payout.factory.js";
import { PayoutsService } from "./payouts/payouts.service.js";
import { StatsService } from "./stats.service.js";
import { CommissionMaturationTask } from "./tasks/commission-maturation.task.js";
import { PayoutBatchTask } from "./tasks/payout-batch.task.js";
import { AdminModule } from "../admin/admin.module.js";
import { ENV } from "../config/config.module.js";
import { UsersModule } from "../users/users.module.js";

/**
 * Affiliate v2 (B07 brief): application/approval, `/r/<code>` attribution,
 * the commission engine, the FY TDS accumulator, `PayoutProvider`-backed
 * monthly payouts, fraud flags, and the dashboard/asset-pack API surface.
 *
 * `EventEmitter2` is global (`EventEmitterModule.forRoot()` in
 * `app.module.ts`) — `InvoiceEventsListener` injects it implicitly through
 * `@OnEvent`, same as `invoices/listeners/billing-events.listener.ts`.
 * `PrismaService` is `@Global()` via `CommonModule`. `AdminModule` supplies
 * `AdminGuard` for the admin approve/suspend/reject routes; `UsersModule`
 * supplies `AuditService`.
 */
@Module({
  imports: [AdminModule, UsersModule],
  controllers: [AffiliatesController],
  providers: [
    AffiliatesService,
    AttributionService,
    AffiliateCodeService,
    CommissionService,
    FraudService,
    StatsService,
    PayoutsService,
    InvoiceEventsListener,
    CommissionMaturationTask,
    PayoutBatchTask,
    {
      provide: PAYOUT_PROVIDER,
      useFactory: (env: Env) => createPayoutProvider(env),
      inject: [ENV],
    },
  ],
  exports: [AffiliatesService, CommissionService, PayoutsService],
})
export class AffiliatesModule {}
