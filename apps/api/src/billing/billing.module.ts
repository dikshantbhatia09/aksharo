import { Module } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { BillingController } from "./billing.controller.js";
import { CheckoutService } from "./checkout.service.js";
import { PassesService } from "./passes.service.js";
import { PlansService } from "./plans.service.js";
import { BILLING_PROVIDER } from "./provider.js";
import { createBillingProvider } from "./providers/provider.factory.js";
import { RefundsService } from "./refunds.service.js";
import { RenewalService } from "./renewal.service.js";
import { SubscriptionService } from "./subscription.service.js";
import { WebhooksService } from "./webhooks.service.js";
import { ENV } from "../config/config.module.js";
import { UsersModule } from "../users/users.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Billing core (B01): the `BillingProvider` port, the plan catalogue,
 * checkout, passes/top-ups, webhooks and subscription management.
 *
 * Imports `WorkspacesModule` for `EntitlementService` (invalidated on every
 * webhook that changes what a workspace may do) and `WorkspaceMemberGuard`
 * (the controller's routes have no `:id` in the path, exactly like
 * `/projects/*`, so it re-checks membership against the token's own
 * workspace). Imports `UsersModule` for `AuditService` — every mutating route
 * here writes `audit_log`, the same rule `WorkspacesModule` follows.
 * `CREDITS_FACADE` (`CreditsModule`) and `NotifyService` (`NotifyModule`) are
 * both `@Global()` already, so nothing extra is imported for them.
 */
@Module({
  imports: [WorkspacesModule, UsersModule],
  controllers: [BillingController],
  providers: [
    PlansService,
    CheckoutService,
    PassesService,
    SubscriptionService,
    WebhooksService,
    RenewalService,
    RefundsService,
    {
      provide: BILLING_PROVIDER,
      useFactory: (env: Env) => createBillingProvider(env),
      inject: [ENV],
    },
  ],
  exports: [
    PlansService,
    CheckoutService,
    PassesService,
    SubscriptionService,
    RenewalService,
    RefundsService,
    BILLING_PROVIDER,
  ],
})
export class BillingModule {}
