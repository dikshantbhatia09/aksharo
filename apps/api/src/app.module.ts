import { Module } from "@nestjs/common";

import { AdminModule } from "./admin/admin.module.js";
import { CommonModule } from "./common/common.module.js";
import { CreditsModule } from "./credits/credits.module.js";
import { HealthModule } from "./health/health.module.js";
import { InternalModule } from "./internal/internal.module.js";
import { JobsModule } from "./jobs/jobs.module.js";
import { RealtimeModule } from "./realtime/realtime.module.js";

/**
 * Root module of the modular monolith. One feature module per work package
 * (05-system-architecture, section 3): `auth`, `users`, `workspaces`, `projects`,
 * `media`, `transcripts`, `edg`, `jobs`, `exports`, `billing`, `credits`, ...
 *
 * A03 wired `common` (config, logging, Prisma, Redis, validation, scheduler) and
 * `health`; A08 adds `credits` (the no-op facade), `realtime`, `jobs` and the
 * signed `internal` surface; A08b adds `admin`, the platform-staff surface behind
 * `AdminGuard`. Later work packages append to `imports`.
 *
 * Order matters only in that `CommonModule` must come first: everything else
 * depends on the global providers it brings.
 */
@Module({
  imports: [
    CommonModule,
    CreditsModule,
    RealtimeModule,
    JobsModule,
    InternalModule,
    AdminModule,
    HealthModule,
  ],
})
export class AppModule {}
