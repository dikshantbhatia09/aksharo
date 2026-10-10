import { Module } from "@nestjs/common";

import { StickersController } from "./stickers.controller.js";
import { StickersService } from "./stickers.service.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * Sticker, Meme & Reaction GIF Overlay Engine Module (Pillar 6 §04).
 */
@Module({
  controllers: [StickersController],
  providers: [StickersService, WorkspaceMemberGuard],
  exports: [StickersService],
})
export class StickersModule {}
