import { Module } from "@nestjs/common";

import { PublicViewerController } from "./public-viewer.controller.js";
import { ShareLinksController } from "./share-links.controller.js";
import { ShareLinksService } from "./share-links.service.js";
import { ShareSessionSigner } from "./token.js";
import { PasswordService } from "../auth/password.service.js";
import { EdgModule } from "../edg/index.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Share links: owner CRUD (`/projects/:id/share-links`), the public viewer
 * (`/s/:token`), password unlock, report-abuse intake, the approve/
 * request-changes decision, and the read-only preview (proxy URL + EDG
 * projection) the web viewer renders (B15 brief §1, §3; increment 2).
 *
 * `PasswordService` (argon2, already used for account passwords) is declared
 * as a local provider rather than imported from `AuthModule`: it has no
 * constructor dependencies of its own and `AuthModule` does not export it, so
 * this reuses the same class without touching a file outside this work
 * package's boundary. `WorkspacesModule` brings `WorkspaceMemberGuard`/
 * `RolesGuard` wiring, same as `ProjectsModule`. `EdgModule` for
 * `EdgRepository.projectionOf` — the same read `ExportsModule` uses to render,
 * so the public preview can never disagree with an actual export.
 * `ShareLinksService` is exported because `CommentsModule` (public comment
 * routes) needs the same scope and liveness checks.
 */
@Module({
  imports: [WorkspacesModule, EdgModule],
  controllers: [ShareLinksController, PublicViewerController],
  providers: [ShareLinksService, ShareSessionSigner, PasswordService],
  exports: [ShareLinksService, ShareSessionSigner],
})
export class ShareModule {}
