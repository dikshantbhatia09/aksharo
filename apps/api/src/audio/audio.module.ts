import { Module } from "@nestjs/common";

import { AudioCleanCompletionHandler } from "./audio.completion.handler.js";
import { AudioController } from "./audio.controller.js";
import { AudioService } from "./audio.service.js";
import { MusicController } from "./music.controller.js";
import { MusicService } from "./music.service.js";
import { StorageModule } from "../common/storage/index.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * Audio clean (B10) & Royalty-Free Music Library (Pillar 5 §04).
 */
@Module({
  imports: [JobsModule, StorageModule, EntitlementsModule],
  controllers: [AudioController, MusicController],
  providers: [AudioService, MusicService, AudioCleanCompletionHandler, WorkspaceMemberGuard],
  exports: [AudioService, MusicService],
})
export class AudioModule {}
