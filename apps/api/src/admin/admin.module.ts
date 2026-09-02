import { Module } from "@nestjs/common";

import { AdminGuard } from "./admin.guard.js";
import { AdminCreditsController } from "./credits/admin-credits.controller.js";
import { AdminDlqController } from "./dlq/dlq.controller.js";
import { AdminParentalWaitlistController } from "./parental-waitlist.controller.js";
import { JobsModule } from "../jobs/jobs.module.js";
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
 * `CreditReconcileService` are already reachable here.
 */
@Module({
  imports: [JobsModule, PrivacyModule],
  controllers: [AdminDlqController, AdminParentalWaitlistController, AdminCreditsController],
  providers: [AdminGuard],
  exports: [AdminGuard],
})
export class AdminModule {}
