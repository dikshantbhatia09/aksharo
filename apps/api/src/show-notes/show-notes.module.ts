import { Module } from "@nestjs/common";

import { ShowNotesController } from "./show-notes.controller.js";
import { ShowNotesService } from "./show-notes.service.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * Automated Show Notes, Chapters & Timestamp Generator (Pillar 7 §04).
 */
@Module({
  controllers: [ShowNotesController],
  providers: [ShowNotesService, WorkspaceMemberGuard],
  exports: [ShowNotesService],
})
export class ShowNotesModule {}

