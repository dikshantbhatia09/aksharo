import { Module } from "@nestjs/common";

import { InternalJobsController } from "./internal-jobs.controller.js";
import { InternalMediaController } from "./internal-media.controller.js";
import { InternalSignatureGuard } from "./internal-signature.guard.js";
import { InternalRoutingOverridesController } from "./routing-overrides.controller.js";
import { JobsModule } from "../jobs/jobs.module.js";

/**
 * The signed worker → API surface (CONTRACTS §3).
 *
 * Kept in its own module rather than inside `jobs` so the guard is the *only* way
 * in: every controller registered here is behind {@link InternalSignatureGuard},
 * and a route that needs it cannot be added anywhere else by accident.
 */
@Module({
  imports: [JobsModule],
  controllers: [
    InternalJobsController,
    InternalMediaController,
    InternalRoutingOverridesController,
  ],
  providers: [InternalSignatureGuard],
  exports: [InternalSignatureGuard],
})
export class InternalModule {}
