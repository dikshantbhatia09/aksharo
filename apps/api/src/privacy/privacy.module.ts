import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";

import { AccessLogInterceptor } from "./access-log.interceptor.js";
import { BreachIncidentsService } from "./breach-incidents.service.js";
import { ErasureCascadeService } from "./erasure-cascade.service.js";
import { ErasureCascadeTask } from "./erasure-cascade.task.js";
import { ParentalWaitlistService } from "./parental-waitlist.service.js";
import { PrivacyController } from "./privacy.controller.js";
import { ResidueCheckService } from "./residue-check.service.js";
import { UsersModule } from "../users/users.module.js";

/**
 * The published privacy notice, and the parental-consent waiting list A04 had to
 * park in Redis (D60, D61).
 *
 * `ParentalWaitlistService` drains that Redis hash into `parental_waitlist` on
 * boot, which is why it is a provider here and not a script: the migration has to
 * run wherever the API runs, exactly once per surviving entry, without an
 * operator remembering to invoke it. It is exported because `AdminModule` serves
 * the list at `GET /admin/parental-waitlist`, behind A08b's `AdminGuard`.
 */
@Module({
  imports: [UsersModule],
  controllers: [PrivacyController],
  providers: [
    ParentalWaitlistService,
    BreachIncidentsService,
    ErasureCascadeService,
    ErasureCascadeTask,
    ResidueCheckService,
    { provide: APP_INTERCEPTOR, useClass: AccessLogInterceptor },
  ],
  exports: [
    ParentalWaitlistService,
    BreachIncidentsService,
    ErasureCascadeService,
    ResidueCheckService,
  ],
})
export class PrivacyModule {}
