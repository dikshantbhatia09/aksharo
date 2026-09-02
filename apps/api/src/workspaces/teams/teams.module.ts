import { Module } from "@nestjs/common";

import { ClientTagsController } from "./client-tags.controller.js";
import { ClientTagsService } from "./client-tags.service.js";
import { OwnershipTransferController } from "./ownership-transfer.controller.js";
import { OwnershipTransferService } from "./ownership-transfer.service.js";
import { SeatBillingListener } from "./seat-billing.listener.js";
import { SeatBillingService } from "./seat-billing.service.js";
import { BillingModule } from "../../billing/billing.module.js";
import { UsersModule } from "../../users/users.module.js";
import { WorkspacesModule } from "../workspaces.module.js";

/**
 * Team/Agency glue (B08 brief §1): seat billing sync and pooled-credit sync
 * reacting to membership events, ownership transfer, and client tags.
 *
 * Imports `BillingModule` for `SubscriptionService.changePlan` (proration) and
 * `WorkspacesModule` for `EntitlementService`, `WorkspaceMemberGuard` and (via
 * its own export) the workspace route table `OwnershipTransferController`/
 * `ClientTagsController` extend. `CREDITS_FACADE` needs no import — `CreditsModule`
 * is `@Global()`.
 *
 * No cycle: `WorkspacesModule` and `BillingModule` both know nothing of this
 * module (`workspaces/members.service.ts` only emits an event —
 * `membership-events.ts` — and never imports anything from `teams/`).
 */
@Module({
  imports: [WorkspacesModule, BillingModule, UsersModule],
  controllers: [OwnershipTransferController, ClientTagsController],
  providers: [SeatBillingService, SeatBillingListener, OwnershipTransferService, ClientTagsService],
  exports: [SeatBillingService, ClientTagsService],
})
export class TeamsModule {}
