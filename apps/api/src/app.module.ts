import { Module } from "@nestjs/common";

import { AdminModule } from "./admin/admin.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { CommonModule } from "./common/common.module.js";
import { ConsentsModule } from "./consents/consents.module.js";
import { CreditsModule } from "./credits/credits.module.js";
import { EdgModule } from "./edg/edg.module.js";
import { FontsModule } from "./fonts/fonts.module.js";
import { HealthModule } from "./health/health.module.js";
import { InternalModule } from "./internal/internal.module.js";
import { JobsModule } from "./jobs/jobs.module.js";
import { MediaModule } from "./media/media.module.js";
import { NotifyModule } from "./notify/notify.module.js";
import { PrivacyModule } from "./privacy/privacy.module.js";
import { ProjectsModule } from "./projects/projects.module.js";
import { RealtimeModule } from "./realtime/realtime.module.js";
import { UsersModule } from "./users/users.module.js";
import { WorkspacesModule } from "./workspaces/workspaces.module.js";

/**
 * Root module of the modular monolith. One feature module per work package
 * (05-system-architecture, section 3): `auth`, `users`, `workspaces`, `projects`,
 * `media`, `transcripts`, `edg`, `jobs`, `exports`, `billing`, `credits`, ...
 *
 * A03 wired `common` (config, logging, Prisma, Redis, validation, scheduler) and
 * `health`; A04 adds `auth` and the minimal `users` it needs; A08 adds `credits`
 * (the no-op facade), `realtime`, `jobs` and the signed `internal` surface; A08b
 * adds `admin`, the platform-staff surface behind `AdminGuard`; A05 fills out
 * `users` and adds `workspaces`, `consents` and `privacy`; A25 adds `notify`
 * (mail delivery and the in-app bell); A12 adds `edg`, the editing document and
 * its op batches; A06 adds `projects` (with folders) and `media` (upload,
 * derived URLs, import, retention); A18b adds `fonts`, the bundled open-licence
 * catalogue and a workspace's own uploads with their licence warranty. Later
 * work packages append to `imports`.
 *
 * `NotifyModule` sits after `JobsModule` because it takes the `notify` queue from
 * that module's registry, and it is `@Global()` because `AuthModule` — declared
 * earlier and `@Global()` itself — injects `NotifyService` to send its links.
 *
 * `ProjectsModule` precedes `MediaModule` because media resolves a project
 * through `ProjectsService`, and both come after `JobsModule`: completing an
 * upload is a producer for `media.probe`, `media.proxy` and `ai.align`.
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
    WorkspacesModule,
    ConsentsModule,
    PrivacyModule,
    CreditsModule,
    RealtimeModule,
    JobsModule,
    NotifyModule,
    ProjectsModule,
    MediaModule,
    InternalModule,
    AdminModule,
    EdgModule,
    FontsModule,
    HealthModule,
  ],
})
export class AppModule {}
