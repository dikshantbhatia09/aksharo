import { Module } from "@nestjs/common";

import { FoldersController } from "./folders.controller.js";
import { FoldersService } from "./folders.service.js";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";
import { RenderPreviewController } from "./render-preview.controller.js";
import { RenderPreviewService } from "./render-preview.js";
import { EdgModule } from "../edg/edg.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { FacesTrigger } from "../media/faces.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Projects and folders (A06).
 *
 * `WorkspacesModule` is imported for two things: `EntitlementService`, which
 * says how long the plan keeps a project, and `WorkspaceMemberGuard`, which every
 * route here wears. Everything else — Prisma, the validation pipe, the object
 * stores — comes from a global module.
 *
 * `ProjectsService` is exported because `MediaModule` and later `TranscriptsModule`
 * and `ExportsModule` all resolve a project the same way: filtered by the token's
 * workspace, so another tenant's id is a 404 rather than a 403 (T5).
 *
 * `EdgModule` (2026-09-26) for `EdgRepository.projectionOf`, which the captions
 * preview (`GET /projects/{id}/render-preview`) reads exactly as the share viewer
 * and the exporter do. It imports nothing, so this adds no cycle.
 *
 * `FacesTrigger`, a second binding of a stateless class (`MediaModule` provides
 * the first; `MediaModule` imports this module, so this one cannot import it),
 * for the same preview: it queues face detection for a video that has none. Its
 * only dependency beyond Prisma is `JobsService`, and `JobsModule` imports
 * nothing either.
 */
@Module({
  imports: [WorkspacesModule, EdgModule, JobsModule],
  controllers: [ProjectsController, FoldersController, RenderPreviewController],
  providers: [ProjectsService, FoldersService, RenderPreviewService, FacesTrigger],
  exports: [ProjectsService, FoldersService],
})
export class ProjectsModule {}
