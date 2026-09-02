import { Module } from "@nestjs/common";

import { AdminModule } from "./admin/admin.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { CommonModule } from "./common/common.module.js";
import { CreditsModule } from "./credits/credits.module.js";
import { HealthModule } from "./health/health.module.js";
import { InternalModule } from "./internal/internal.module.js";
import { JobsModule } from "./jobs/jobs.module.js";
import { NotifyModule } from "./notify/notify.module.js";
import { RealtimeModule } from "./realtime/realtime.module.js";
import { UsersModule } from "./users/users.module.js";

/**
 * Root module of the modular monolith. One feature module per work package
 * (05-system-architecture, section 3): `auth`, `users`, `workspaces`, `projects`,
 * `media`, `transcripts`, `edg`, `jobs`, `exports`, `billing`, `credits`, ...
 *
 * A03 wired `common` (config, logging, Prisma, Redis, validation, scheduler) and
 * `health`; A04 adds `auth` and the minimal `users` it needs; A08 adds `credits`
 * (the no-op facade), `realtime`, `jobs` and the signed `internal` surface; A08b
 * adds `admin`, the platform-staff surface behind `AdminGuard`; A25 adds `notify`
 * (mail delivery and the in-app bell). Later work packages append to `imports`.
 *
 * `NotifyModule` sits after `JobsModule` because it takes the `notify` queue from
 * that module's registry, and it is `@Global()` because `AuthModule` — declared
 * earlier and `@Global()` itself — injects `NotifyService` to send its links.
 *
 * Order matters only in that `CommonModule` must come first: everything else
 * depends on the global providers it brings. `AuthModule` follows it because it
 * is `@Global()` too — it binds the token `JwtAuthGuard` resolves.
 */
@Module({
  imports: [
    CommonModule,
    UsersModule,
    AuthModule,
    CreditsModule,
    RealtimeModule,
    JobsModule,
    NotifyModule,
    InternalModule,
    AdminModule,
    HealthModule,
  ],
})
export class AppModule {}
