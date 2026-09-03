/**
 * `PlannerClient` — the port `PromptedEditsService` calls to turn an
 * `EditPlanInput` into an `EditPlanOutput` (D07).
 *
 * Unlike `chapters`/`summary`/`hooks` (B11), whose LLM calls always round-trip
 * through the `ai.llm` queue and `apps/worker-ai` (`InsightsCompletionHandler`
 * owns that queue exclusively — `JobCompletionRegistry` allows exactly one
 * handler per queue, and `insights.completion.handler.ts` is outside this
 * work package's file boundaries), the planner is called in-process through
 * this small port instead. Two implementations:
 *
 * - {@link MockPlannerClient}: `@montaj/prompts`' deterministic
 *   `mockEditPlan` — the fixture/mock LLM seam this whole feature is proven
 *   through on a machine with no LLM keys (brief environment note). Bound by
 *   default.
 * - {@link AnthropicPlannerClient}: a real Anthropic Messages API call built
 *   from `editPlanTemplate.build()`/`maxTokens`/`temperature`, type-checked
 *   here but never exercised by a test or bound in this environment (no
 *   `ANTHROPIC_API_KEY` on the build machine) — the module only binds it when
 *   the key is present (`prompted-edits.module.ts`).
 */
import { Injectable, Logger } from "@nestjs/common";

import { editPlanTemplate, mockEditPlan } from "@montaj/prompts";
import type { EditPlanInput, EditPlanOutput } from "@montaj/prompts";

export interface PlannerGenerateResult {
  readonly output: EditPlanOutput;
  readonly provider: string;
  readonly templateVersion: string;
}

export interface PlannerClient {
  generate(input: EditPlanInput): Promise<PlannerGenerateResult>;
}

export const PLANNER_CLIENT = Symbol("PLANNER_CLIENT");

@Injectable()
export class MockPlannerClient implements PlannerClient {
  async generate(input: EditPlanInput): Promise<PlannerGenerateResult> {
    return Promise.resolve({
      output: mockEditPlan(input),
      provider: "mock",
      templateVersion: editPlanTemplate.version,
    });
  }
}

interface AnthropicMessageResponse {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
}

/**
 * Real provider path (type-checked, never invoked on this machine — see file
 * doc comment). A minimal Anthropic Messages API call using
 * `editPlanTemplate.build()`'s `{system, user}` pair, parsing the first text
 * block as JSON and validating it against `editPlanTemplate.outputSchema`.
 */
@Injectable()
export class AnthropicPlannerClient implements PlannerClient {
  private readonly logger = new Logger(AnthropicPlannerClient.name);

  constructor(private readonly apiKey: string) {}

  async generate(input: EditPlanInput): Promise<PlannerGenerateResult> {
    const messages = editPlanTemplate.build(input);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: editPlanTemplate.maxTokens,
        temperature: editPlanTemplate.temperature,
        system: messages.system,
        messages: [{ role: "user", content: messages.user }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Anthropic planner call failed: ${String(response.status)}`);
    }
    const body = (await response.json()) as AnthropicMessageResponse;
    const text = body.content?.find((block) => block.type === "text")?.text ?? "{}";
    const parsed: unknown = JSON.parse(text);
    const output = editPlanTemplate.outputSchema.parse(parsed);
    this.logger.log({ templateVersion: editPlanTemplate.version }, "real planner call completed");
    return { output, provider: "anthropic", templateVersion: editPlanTemplate.version };
  }
}
