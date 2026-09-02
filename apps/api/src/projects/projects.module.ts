import { Module } from "@nestjs/common";

import { FoldersController } from "./folders.controller.js";
import { FoldersService } from "./folders.service.js";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";
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
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [ProjectsController, FoldersController],
  providers: [ProjectsService, FoldersService],
  exports: [ProjectsService, FoldersService],
})
export class ProjectsModule {}
