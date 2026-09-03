import { Module } from "@nestjs/common";

import {
  AnthropicPlannerClient,
  MockPlannerClient,
  OllamaPlannerClient,
  PLANNER_CLIENT,
} from "./planner-client.js";
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
 * `PLANNER_CLIENT` binds, in order: `OllamaPlannerClient` when
 * `LLM_PROVIDER=ollama` (M20 free-stack mode — no key required, real on this
 * machine); else `AnthropicPlannerClient` when `ANTHROPIC_API_KEY` is set
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
      useFactory: () => {
        if (process.env["LLM_PROVIDER"] === "ollama") {
          const baseUrl = process.env["LLM_BASE_URL"]?.trim() || "http://127.0.0.1:11434/v1";
          const model = process.env["LLM_MODEL"]?.trim() || "qwen2.5:3b";
          return new OllamaPlannerClient(baseUrl, model);
        }
        const apiKey = process.env["ANTHROPIC_API_KEY"];
        return apiKey === undefined || apiKey === ""
          ? new MockPlannerClient()
          : new AnthropicPlannerClient(apiKey);
      },
    },
  ],
  exports: [PromptedEditsService],
})
export class PromptedEditsModule {}
