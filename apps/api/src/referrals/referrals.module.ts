import { Module } from "@nestjs/common";

import { ExportCompletedListener } from "./export-completed.listener.js";
import { ReferralsController } from "./referrals.controller.js";
import { ReferralsService } from "./referrals.service.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * The give-get referral loop (D53, F-607, B07b).
 *
 * `WorkspacesModule` for `WorkspaceMemberGuard` (THREAT-MODEL T4) and
 * `EntitlementService` (the Free-plan monthly cap). `CREDITS_FACADE` and
 * `EventEmitter2` are both `@Global()` already (`CreditsModule`,
 * `app.module.ts`'s `EventEmitterModule.forRoot()`), so neither needs an
 * import here — `ExportCompletedListener` picks up `export.completed`
 * (emitted from `exports/`, see `export-completed.event.ts`) purely through
 * `@OnEvent`.
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [ReferralsController],
  providers: [ReferralsService, ExportCompletedListener],
  exports: [ReferralsService],
})
export class ReferralsModule {}
