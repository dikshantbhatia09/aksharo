import { Module } from "@nestjs/common";

import { AdminAcquisitionController } from "./acquisition/admin-acquisition.controller.js";
import { AdminAcquisitionService } from "./acquisition/admin-acquisition.service.js";
import { AdminGuard } from "./admin.guard.js";
import { AdminStepUpController } from "./auth/admin-step-up.controller.js";
import { AdminStepUpService } from "./auth/admin-step-up.service.js";
import { AdminCreditsController } from "./credits/admin-credits.controller.js";
import { AdminDlqController } from "./dlq/dlq.controller.js";
import { AdminParentalWaitlistController } from "./parental-waitlist.controller.js";
import { AdminPrivacyController } from "./privacy/admin-privacy.controller.js";
import { AdminSchedulerController } from "./scheduler/admin-scheduler.controller.js";
import { AdminStreakController } from "./streak/admin-streak.controller.js";
import { AdminStreakService } from "./streak/admin-streak.service.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { AdminOffersController } from "../offers/admin-offers.controller.js";
import { OffersModule } from "../offers/offers.module.js";
import { PrivacyModule } from "../privacy/privacy.module.js";

/**
 * The platform-staff surface: routes that cross workspace boundaries.
 *
 * Its own module, in the same spirit as `InternalModule`: every controller
 * registered here is behind {@link AdminGuard}, so an admin route cannot be added
 * to an ordinary feature module by accident and quietly ship without the guard
 * (THREAT-MODEL T20).
 *
 * A08b lands the dead-letter queue; A05 adds the parental-consent waiting list,
 * which belongs to nobody's workspace and so has no membership that could
 * authorise reading it. B13 builds the admin console on top and adds the rest.
 *
 * Only the modules owning those services are imported: A04's `JwtAuthGuard`,
 * which {@link AdminGuard} composes, comes from the `@Global()` `AuthModule`, and
 * `PrismaService` from the global `PrismaModule`. `AdminCreditsController`
 * (B02) needs no import of its own: `CreditsModule` is `@Global()`, exactly
 * like `JwtAuthGuard`'s module, so `CreditOrphanedHoldsService` and
 * `CreditReconcileService` are already reachable here. `OffersModule` (B04)
 * is imported for `AdminOffersController` (`GET /admin/metrics/offers`, the
 * ₹9-hypothesis instrumentation), which is not `@Global()`.
 */
@Module({
  imports: [JobsModule, PrivacyModule, OffersModule],
  controllers: [
    AdminStepUpController,
    AdminDlqController,
    AdminParentalWaitlistController,
    AdminCreditsController,
    AdminOffersController,
    AdminStreakController,
    AdminAcquisitionController,
    AdminPrivacyController,
    AdminSchedulerController,
  ],
  providers: [AdminGuard, AdminStepUpService, AdminStreakService, AdminAcquisitionService],
  exports: [AdminGuard],
})
export class AdminModule {}
