import { Module } from "@nestjs/common";

import { BundledFontsService } from "./bundled-fonts.service.js";
import {
  BundledFontsController,
  FontUploadsController,
  WorkspaceFontsController,
} from "./fonts.controller.js";
import { FontsService } from "./fonts.service.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Fonts (A18b): the bundled open-licence catalogue, and a workspace's own
 * uploads with their licence warranty.
 *
 * `WorkspacesModule` is imported for `EntitlementService` (the plan's custom
 * font allowance) and for `WorkspaceMemberGuard`. No `JobsModule`: sanitisation
 * runs inline because CONTRACTS §3 has no font queue — see `fonts.service.ts`.
 *
 * `FontsService` is exported so B16's erasure sweep can call `purgeWorkspace`.
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [BundledFontsController, WorkspaceFontsController, FontUploadsController],
  providers: [FontsService, BundledFontsService],
  exports: [FontsService, BundledFontsService],
})
export class FontsModule {}
