/**
 * `pnpm --filter @montaj/prompts eval:local` (M20 free-stack mode): the same
 * templates/fixtures/checks `eval.ts`/`runner.ts` use against the mock
 * provider, run once for real against a local Ollama server instead — proof
 * that the actual prompts hold up against a real (if small) model, without
 * making the CI-critical `eval` command touch the network.
 *
 * This is a third mirror of the same OpenAI-compatible request shape
 * `apps/worker-ai/worker_ai/llm/providers/ollama.py` and
 * `apps/api/src/prompted-edits/planner-client.ts`'s `OllamaPlannerClient`
 * already implement — kept here rather than imported from either because
 * `packages/prompts` has no dependency on `apps/api`/`apps/worker-ai` (and
 * must not gain one: it is imported by both). All three call the same
 * `/chat/completions` endpoint with `response_format: json_object` and the
 * same one-repair-attempt-on-invalid-JSON shape as
 * `apps/worker-ai/worker_ai/llm/service.py`.
 */
import type { TemplateDefinition } from "../templates/types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_MODEL = "qwen2.5:3b";

export function ollamaBaseUrl(): string {
  const value = process.env["LLM_BASE_URL"]?.trim();
  return value === undefined || value === "" ? DEFAULT_BASE_URL : value.replace(/\/+$/, "");
}

export function ollamaModel(): string {
  const value = process.env["LLM_MODEL"]?.trim();
  return value === undefined || value === "" ? DEFAULT_MODEL : value;
}

/** A short, cheap probe so `eval:local` can skip cleanly when nothing is listening. */
export async function isOllamaReachable(baseUrl: string, timeoutMs = 1_500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    // `/v1/models` is the OpenAI-compatible list-models endpoint Ollama serves
    // alongside `/v1/chat/completions` — cheaper than a real generation call.
    const response = await fetch(`${baseUrl}/models`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface OpenAiCompatibleChatResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: string } }[];
}

async function callOllama(
  baseUrl: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      stream: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama call failed: ${String(response.status)}`);
  }
  const body = (await response.json()) as OpenAiCompatibleChatResponse;
  return body.choices?.[0]?.message?.content ?? "{}";
}

export interface OllamaGenerateResult<Output> {
  readonly output: Output;
  readonly latencyMs: number;
}

/**
 * Build the template's messages, call Ollama, validate against
 * `template.outputSchema`; on failure, retry once with a repair message
 * (mirrors `apps/worker-ai/worker_ai/llm/service.py`'s one-repair path).
 * Throws (with both failure reasons) if the repair attempt is also invalid.
 */
export async function generateWithOllama<Input, Output>(
  template: TemplateDefinition<Input, Output>,
  input: Input,
  options: { baseUrl?: string; model?: string } = {},
): Promise<OllamaGenerateResult<Output>> {
  const baseUrl = options.baseUrl ?? ollamaBaseUrl();
  const model = options.model ?? ollamaModel();
  const messages = template.build(input);
  const start = performance.now();

  const attempt = (text: string): { ok: true; output: Output } | { ok: false; reason: string } => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        ok: false,
        reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const result = template.outputSchema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, reason: `schema validation failed: ${result.error.message}` };
    }
    return { ok: true, output: result.data };
  };

  const first = attempt(
    await callOllama(
      baseUrl,
      model,
      messages.system,
      messages.user,
      template.maxTokens,
      template.temperature,
    ),
  );
  if (first.ok) {
    return { output: first.output, latencyMs: performance.now() - start };
  }
  const repairUser =
    `${messages.user}\n\n<repair>\nYour previous reply did not match the required JSON schema. ` +
    `Errors: ${first.reason}. Reply again with corrected strict JSON only, same shape as requested.\n</repair>`;
  const second = attempt(
    await callOllama(
      baseUrl,
      model,
      messages.system,
      repairUser,
      template.maxTokens,
      template.temperature,
    ),
  );
  if (second.ok) {
    return { output: second.output, latencyMs: performance.now() - start };
  }
  throw new Error(`output failed schema validation twice: ${first.reason}; ${second.reason}`);
}
