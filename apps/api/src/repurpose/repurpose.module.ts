import { Module } from "@nestjs/common";

import { RepurposeController } from "./repurpose.controller.js";
import { RepurposeService } from "./repurpose.service.js";
import { MediaModule } from "../media/media.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { IdempotencyService } from "../public-api/v1/idempotency.service.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { StylesModule } from "../styles/styles.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * REP-006: the guided repurposing run.
 *
 * It imports the modules whose services it reuses rather than reimplementing
 * them — `ProjectsModule` creates the source project with the workspace's own
 * retention and plan rules, and `MediaModule` issues the ordinary multipart
 * ticket so an upload joins the existing probe/proxy/transcribe chain unchanged.
 *
 * `StylesModule` is imported for one reason: a run FREEZES its caption style, so
 * the id has to be checked against the workspace's catalogue before it is frozen.
 *
 * `IdempotencyService` is provided directly rather than imported from
 * `PublicApiModule`: it is a stateless reader of one table, so a second instance
 * behaves identically, and importing the public API module here would drag its
 * controllers and their dependencies into a surface that is still switched off.
 *
 * Nothing in this module runs while `repurpose_flow` is disabled, which is how
 * it is seeded (`prisma/seed-data.ts`) and how it stays until CP-010 passes.
 */
@Module({
  imports: [ProjectsModule, MediaModule, StylesModule, WorkspacesModule, RealtimeModule],
  controllers: [RepurposeController],
  providers: [RepurposeService, IdempotencyService],
  exports: [RepurposeService],
})
export class RepurposeModule {}
