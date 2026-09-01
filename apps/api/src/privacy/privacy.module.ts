import { Module } from "@nestjs/common";

import { ParentalWaitlistService } from "./parental-waitlist.service.js";
import { PlatformAdminGuard } from "./platform-admin.guard.js";
import { PrivacyController } from "./privacy.controller.js";
import { UsersModule } from "../users/users.module.js";

/**
 * The published privacy notice, and the parental-consent waiting list A04 had to
 * park in Redis (D60, D61).
 *
 * `ParentalWaitlistService` drains that Redis hash into `parental_waitlist` on
 * boot, which is why it is a provider here and not a script: the migration has to
 * run wherever the API runs, exactly once per surviving entry, without an
 * operator remembering to invoke it.
 */
@Module({
  imports: [UsersModule],
  controllers: [PrivacyController],
  providers: [ParentalWaitlistService, PlatformAdminGuard],
  exports: [ParentalWaitlistService],
})
export class PrivacyModule {}
