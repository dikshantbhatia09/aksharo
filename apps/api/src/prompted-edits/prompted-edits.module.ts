import { Module } from "@nestjs/common";

import { MockPlannerClient, PLANNER_CLIENT, plannerClientFor } from "./planner-client.js";
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
 * `PLANNER_CLIENT` binds, in order (`plannerClientFor`): `OllamaPlannerClient`
 * when `LLM_PROVIDER=ollama` or `sarvam` (M20 free-stack mode — no key
 * required, real on this machine); else `AnthropicPlannerClient` when `ANTHROPIC_API_KEY` is set
 * (type-checked, never exercised by a test here); else `MockPlannerClient`,
 * the fixture/mock LLM seam this feature is proven through when no LLM is
 * configured at all.
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
      useFactory: () => plannerClientFor(process.env),
    },
  ],
  exports: [PromptedEditsService],
})
export class PromptedEditsModule {}
