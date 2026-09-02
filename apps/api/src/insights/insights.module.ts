import { Module } from "@nestjs/common";

import { InsightsCompletionHandler } from "./insights.completion.handler.js";
import { InsightsController } from "./insights.controller.js";
import { InsightsRepository } from "./insights.repository.js";
import { InsightsService } from "./insights.service.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { TranscriptsModule } from "../transcripts/transcripts.module.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * `/projects/{id}/insights` (B11): the producer (`InsightsService.request`),
 * the reads, and what an `ai.llm` completion does
 * (`InsightsCompletionHandler`).
 *
 * `TranscriptsModule` for `TranscriptsService.chunks()` — the transcript text
 * the prompt is built from; `JobsModule` for the producer and the completion
 * registry. `WorkspaceMemberGuard` is bound here the same way
 * `TranscriptsModule` binds it (A05 does not export it).
 */
@Module({
  imports: [JobsModule, TranscriptsModule],
  controllers: [InsightsController],
  providers: [InsightsService, InsightsRepository, InsightsCompletionHandler, WorkspaceMemberGuard],
  exports: [InsightsService, InsightsRepository],
})
export class InsightsModule {}
