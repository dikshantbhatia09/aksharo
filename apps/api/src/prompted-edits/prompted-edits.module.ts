import { Module } from "@nestjs/common";

import { AnthropicPlannerClient, MockPlannerClient, PLANNER_CLIENT } from "./planner-client.js";
import { PromptedEditsController } from "./prompted-edits.controller.js";
import { PromptedEditsService } from "./prompted-edits.service.js";
import { EdgModule } from "../edg/index.js";
import { PassesModule } from "../passes/passes.module.js";
import { TranscriptsModule } from "../transcripts/transcripts.module.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * `/projects/{id}/prompted-edits` (D07): the planner producer and the plan
 * run/read endpoints.
 *
 * `PassesModule` for `PassesService.start*`/`finishedDurationMs` — the same
 * one-directional import `prompted-chain.ts`'s doc comment describes
 * (`PassesModule` never imports this module back, so there is no cycle).
 * `PLANNER_CLIENT` binds `MockPlannerClient` (the fixture/mock LLM seam this
 * feature is proven through, brief environment note: no LLM keys on this
 * machine) unless `ANTHROPIC_API_KEY` is set, in which case it binds
 * `AnthropicPlannerClient` (type-checked, never exercised by a test here).
 */
@Module({
  imports: [PassesModule, EdgModule, TranscriptsModule],
  controllers: [PromptedEditsController],
  providers: [
    PromptedEditsService,
    WorkspaceMemberGuard,
    MockPlannerClient,
    {
      provide: PLANNER_CLIENT,
      useFactory: () => {
        const apiKey = process.env["ANTHROPIC_API_KEY"];
        return apiKey === undefined || apiKey === "" ? new MockPlannerClient() : new AnthropicPlannerClient(apiKey);
      },
    },
  ],
  exports: [PromptedEditsService],
})
export class PromptedEditsModule {}
