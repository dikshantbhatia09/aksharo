import { Module } from "@nestjs/common";

import { NinePassEligibilityService } from "./nine-pass-eligibility.service.js";
import { PassesNinePassLedger } from "./nine-pass-ledger.impl.js";
import { OffersMetricsService } from "./offers-metrics.service.js";
import { OffersController } from "./offers.controller.js";
import { OffersService } from "./offers.service.js";
import { NINE_PASS_LEDGER } from "../exports/nine-pass-ledger.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Offers (B04): backs the interfaces A21 left as no-ops — the real
 * `NinePassLedger` (`PassesNinePassLedger`, bound to `ExportsModule`'s
 * `NINE_PASS_LEDGER` token) and ₹9-pass eligibility — plus the read model the
 * web upsell panel and Subscription overview render from
 * (`GET /offers/eligibility`, `GET /offers/passes`).
 *
 * **Dependency direction, deliberately one-way.** `BillingModule` imports this
 * module (`PassesService` needs `NinePassEligibilityService` to enforce "never
 * on a paid plan, once per 30 days" server-side at checkout — the brief's own
 * "integration with B01 checkout" line); `ExportsModule` and `AdminModule` do
 * too. This module imports neither of them — not `BillingModule` for
 * `BILLING_PROVIDER`/`WebhooksService` (the dev-only payment simulator that
 * needs those, `offers-dev.controller.ts`, is registered under
 * `BillingModule` instead, precisely to avoid the cycle a bidirectional import
 * would create), not `ExportsModule` (only the interface file
 * `exports/nine-pass-ledger.ts` is imported, a type/token, never
 * `ExportsModule` itself). The signup gift stays where A21 put it
 * (`exports.service.ts` reads `workspace.signupGiftConsumedAt` directly) —
 * `OffersService.eligibility()` only *reads* that same column for the upsell
 * panel's first line, it does not own the gift's lifecycle.
 *
 * `AdminOffersController` (`GET /admin/metrics/offers`, the ₹9-hypothesis
 * instrumentation) is *not* registered here even though its file lives in this
 * folder — `admin/admin.module.ts` imports this module and registers it there
 * instead, the exact convention `AdminCreditsController` already set (its file
 * lives in `credits/`, its route is registered in `admin.module.ts`): every
 * admin route lives in one place to audit (THREAT-MODEL T20), and registering
 * it here too would make `OffersModule` depend on `AdminModule` for
 * `AdminGuard` with no benefit.
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [OffersController],
  providers: [
    OffersService,
    NinePassEligibilityService,
    OffersMetricsService,
    { provide: NINE_PASS_LEDGER, useClass: PassesNinePassLedger },
  ],
  exports: [NinePassEligibilityService, OffersMetricsService, NINE_PASS_LEDGER],
})
export class OffersModule {}
