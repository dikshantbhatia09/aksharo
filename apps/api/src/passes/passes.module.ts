import { Module } from "@nestjs/common";

import { PassCompletionHandler } from "./passes-completion.handler.js";
import { PassesController } from "./passes.controller.js";
import { PassesService } from "./passes.service.js";
import { PromptedChainAdvancer } from "./prompted-chain.js";
import { AudioAssetsModule } from "../audio-assets/index.js";
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
 *
 * `PromptedChainAdvancer` (D07) lives here rather than in
 * `PromptedEditsModule` so `PassCompletionHandler` — the sole owner of the
 * `ai.pass` queue — can call it without a circular module import;
 * `PromptedEditsModule` imports `PassesModule` (one direction only) to reuse
 * `PassesService.start*` for its own chain kickoff.
 */
@Module({
  imports: [JobsModule, EdgModule, TranscriptsModule, AudioAssetsModule],
  controllers: [PassesController],
  providers: [PassesService, PassCompletionHandler, PromptedChainAdvancer, WorkspaceMemberGuard],
  exports: [PassesService],
})
export class PassesModule {}
