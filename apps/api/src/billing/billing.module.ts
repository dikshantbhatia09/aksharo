import { Module } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { BillingController } from "./billing.controller.js";
import { CheckoutService } from "./checkout.service.js";
import { PassesService } from "./passes.service.js";
import { PlansService } from "./plans.service.js";
import { BILLING_PROVIDER } from "./provider.js";
import { createBillingProvider } from "./providers/provider.factory.js";
import { RenewalService } from "./renewal.service.js";
import { SubscriptionService } from "./subscription.service.js";
import { WebhooksService } from "./webhooks.service.js";
import { ENV } from "../config/config.module.js";
import { OffersDevController } from "../offers/offers-dev.controller.js";
import { OffersModule } from "../offers/offers.module.js";
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
 *
 * Imports `OffersModule` (B04) for `NinePassEligibilityService` —
 * `PassesService.passCheckout` asserts it before quoting a `first_export`
 * order, the server-side half of "INR-only, once per account per 30 days,
 * never on a paid plan" (a client that never shows the button is not
 * enforcement). `OffersDevController` (`POST
 * /offers/dev/simulate-nine-pass-payment`) is registered here rather than in
 * `OffersModule` because it needs `BILLING_PROVIDER` and `WebhooksService`,
 * both native to this module — see that controller's own doc comment.
 */
@Module({
  imports: [WorkspacesModule, UsersModule, OffersModule],
  controllers: [BillingController, OffersDevController],
  providers: [
    PlansService,
    CheckoutService,
    PassesService,
    SubscriptionService,
    WebhooksService,
    RenewalService,
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
    BILLING_PROVIDER,
  ],
})
export class BillingModule {}
