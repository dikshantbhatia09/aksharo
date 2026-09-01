import { Module } from "@nestjs/common";

import { AdminGuard } from "./admin.guard.js";
import { AdminDlqController } from "./dlq/dlq.controller.js";
import { JobsModule } from "../jobs/jobs.module.js";

/**
 * The platform-staff surface: routes that cross workspace boundaries.
 *
 * Its own module, in the same spirit as `InternalModule`: every controller
 * registered here is behind {@link AdminGuard}, so an admin route cannot be added
 * to an ordinary feature module by accident and quietly ship without the guard
 * (THREAT-MODEL T20).
 *
 * A08b lands one controller — the dead-letter queue. B13 builds the admin console
 * on top and adds the rest.
 *
 * Only `JobsModule` is imported: `AccessTokenGuard`, which {@link AdminGuard}
 * composes, comes from the `@Global()` `RealtimeModule`, and `PrismaService` from
 * the global `PrismaModule`.
 */
@Module({
  imports: [JobsModule],
  controllers: [AdminDlqController],
  providers: [AdminGuard],
  exports: [AdminGuard],
})
export class AdminModule {}
