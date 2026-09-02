import { Module } from "@nestjs/common";

import { PassCompletionHandler } from "./passes-completion.handler.js";
import { PassesController } from "./passes.controller.js";
import { PassesService } from "./passes.service.js";
import { EdgModule } from "../edg/index.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { TranscriptsModule } from "../transcripts/transcripts.module.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * Edit passes (B18): the autocut producer, its reads, and what an `ai.pass`
 * completion does.
 *
 * `JobsModule` for `JobsService.enqueue` and the completion registry;
 * `EdgModule` for `EdgService.passes`/`segments`/`applyWorkerOps` — the only
 * way this module reads or writes an editing document; `TranscriptsModule` for
 * `TranscriptsRepository.allChunks`, exported alongside `TranscriptsService`
 * for exactly this kind of cross-module read (`transcripts.module.ts`).
 */
@Module({
  imports: [JobsModule, EdgModule, TranscriptsModule],
  controllers: [PassesController],
  providers: [PassesService, PassCompletionHandler, WorkspaceMemberGuard],
  exports: [PassesService],
})
export class PassesModule {}
