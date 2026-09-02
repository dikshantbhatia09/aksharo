import { Module } from "@nestjs/common";

import { CommentsController } from "./comments.controller.js";
import { CommentsService } from "./comments.service.js";
import { NotifyModule } from "../notify/notify.module.js";
import { ShareModule } from "../share/share.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Comments (B15 brief §2): threaded, time-anchored, reachable from an
 * authenticated workspace member or a public share-link reviewer.
 *
 * `ShareModule` for `ShareLinksService` (scope/liveness checks the public
 * routes reuse); `NotifyModule` for the `share-comment` digest to the project
 * owner; `WorkspacesModule` for the guard chain on the authenticated routes.
 */
@Module({
  imports: [ShareModule, NotifyModule, WorkspacesModule],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
