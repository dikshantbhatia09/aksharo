/**
 * `PlannerClient` — the port `PromptedEditsService` calls to turn an
 * `EditPlanInput` into an `EditPlanOutput` (D07).
 *
 * Unlike `chapters`/`summary`/`hooks` (B11), whose LLM calls always round-trip
 * through the `ai.llm` queue and `apps/worker-ai` (`InsightsCompletionHandler`
 * owns that queue exclusively — `JobCompletionRegistry` allows exactly one
 * handler per queue, and `insights.completion.handler.ts` is outside this
 * work package's file boundaries), the planner is called in-process through
 * this small port instead. Implementations:
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
 * - {@link OllamaPlannerClient} (M20 free-stack mode): the same shape as
 *   {@link AnthropicPlannerClient} but against a local, OpenAI-compatible
 *   Ollama server (`LLM_BASE_URL`, default `http://127.0.0.1:11434/v1`;
 *   `LLM_MODEL`, default `qwen2.5:3b`) — no key required, bound when
 *   `LLM_PROVIDER=ollama` (`prompted-edits.module.ts`).
 *
 * Both real clients share {@link parseEditPlanJsonWithRetry}: one retry with
 * a "your reply did not match the schema" repair message when the model's
 * text is not valid JSON or fails `editPlanTemplate.outputSchema` — the same
 * one-repair-attempt shape `apps/worker-ai/worker_ai/llm/service.py` uses for
 * every insight template.
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

/**
 * Parse `text` as JSON and validate it against `editPlanTemplate.outputSchema`;
 * on failure, call `retry(reason)` once with a description of what went wrong
 * and validate its result too. Throws the original failure reason if the
 * retry also fails, so the caller's error message names the real problem
 * rather than the retry's.
 */
async function parseEditPlanJsonWithRetry(
  text: string,
  retry: (reason: string) => Promise<string>,
): Promise<EditPlanOutput> {
  const attempt = (
    candidate: string,
  ): { ok: true; output: EditPlanOutput } | { ok: false; reason: string } => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      return {
        ok: false,
        reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const result = editPlanTemplate.outputSchema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, reason: `schema validation failed: ${result.error.message}` };
    }
    return { ok: true, output: result.data };
  };

  const first = attempt(text);
  if (first.ok) {
    return first.output;
  }
  const repaired = await retry(first.reason);
  const second = attempt(repaired);
  if (second.ok) {
    return second.output;
  }
  throw new Error(
    `edit plan output failed schema validation twice: ${first.reason}; ${second.reason}`,
  );
}

interface AnthropicMessageResponse {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
}

/**
 * Real provider path (type-checked, never invoked on this machine — see file
 * doc comment). A minimal Anthropic Messages API call using
 * `editPlanTemplate.build()`'s `{system, user}` pair, parsing the first text
 * block as JSON and validating it against `editPlanTemplate.outputSchema`,
 * with one repair attempt on invalid output ({@link parseEditPlanJsonWithRetry}).
 */
@Injectable()
export class AnthropicPlannerClient implements PlannerClient {
  private readonly logger = new Logger(AnthropicPlannerClient.name);

  constructor(private readonly apiKey: string) {}

  private async call(system: string, user: string): Promise<string> {
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
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Anthropic planner call failed: ${String(response.status)}`);
    }
    const body = (await response.json()) as AnthropicMessageResponse;
    return body.content?.find((block) => block.type === "text")?.text ?? "{}";
  }

  async generate(input: EditPlanInput): Promise<PlannerGenerateResult> {
    const messages = editPlanTemplate.build(input);
    const text = await this.call(messages.system, messages.user);
    const output = await parseEditPlanJsonWithRetry(text, (reason) =>
      this.call(messages.system, repairUserMessage(messages.user, reason)),
    );
    this.logger.log({ templateVersion: editPlanTemplate.version }, "real planner call completed");
    return { output, provider: "anthropic", templateVersion: editPlanTemplate.version };
  }
}

interface OpenAiCompatibleChatResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
}

/**
 * M20 free-stack mode: a local, OpenAI-compatible Ollama server. No key —
 * `LLM_BASE_URL`/`LLM_MODEL` (defaults `http://127.0.0.1:11434/v1` /
 * `qwen2.5:3b`) are enough. JSON mode via `response_format: json_object`
 * (Ollama's OpenAI-compat endpoint honours the same flag OpenAI's does), with
 * the same one-repair-attempt path as {@link AnthropicPlannerClient}.
 */
@Injectable()
export class OllamaPlannerClient implements PlannerClient {
  private readonly logger = new Logger(OllamaPlannerClient.name);
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly model: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async call(system: string, user: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: editPlanTemplate.maxTokens,
        temperature: editPlanTemplate.temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        stream: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`Ollama planner call failed: ${String(response.status)}`);
    }
    const body = (await response.json()) as OpenAiCompatibleChatResponse;
    return body.choices?.[0]?.message?.content ?? "{}";
  }

  async generate(input: EditPlanInput): Promise<PlannerGenerateResult> {
    const messages = editPlanTemplate.build(input);
    const text = await this.call(messages.system, messages.user);
    const output = await parseEditPlanJsonWithRetry(text, (reason) =>
      this.call(messages.system, repairUserMessage(messages.user, reason)),
    );
    this.logger.log({ templateVersion: editPlanTemplate.version }, "real planner call completed");
    return { output, provider: "ollama", templateVersion: editPlanTemplate.version };
  }
}

function repairUserMessage(user: string, reason: string): string {
  return (
    `${user}\n\n<repair>\nYour previous reply did not match the required JSON schema. ` +
    `Errors: ${reason}. Reply again with corrected strict JSON only, same shape as requested.\n</repair>`
  );
}
