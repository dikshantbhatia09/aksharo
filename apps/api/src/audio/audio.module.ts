import { Module } from "@nestjs/common";

import { AudioCleanCompletionHandler } from "./audio.completion.handler.js";
import { AudioController } from "./audio.controller.js";
import { AudioService } from "./audio.service.js";
import { StorageModule } from "../common/storage/index.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * Audio clean (B10): the producer, the reads, and what an `ai.clean`
 * completion writes back.
 *
 * `JobsModule` for `JobsService.enqueue` and the completion registry;
 * `StorageModule` for the derived-bucket `ObjectStore` the reads sign URLs
 * from; `EntitlementsModule` for `@RequiresEntitlement("audioClean")`.
 * `WorkspaceMemberGuard` is re-declared here the way `TranscriptsModule`
 * re-declares it: A05 provides it without exporting it, and it depends on
 * nothing but the global `PrismaService`.
 */
@Module({
  imports: [JobsModule, StorageModule, EntitlementsModule],
  controllers: [AudioController],
  providers: [AudioService, AudioCleanCompletionHandler, WorkspaceMemberGuard],
  exports: [AudioService],
})
export class AudioModule {}
