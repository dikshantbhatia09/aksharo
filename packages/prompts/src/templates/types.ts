/**
 * The template registry contract (B11).
 *
 * A template is a versioned, pure description of one LLM call: what goes in,
 * what must come back, and the string builder that turns the input into the
 * `{system, user}` messages actually sent to a provider. Nothing here calls a
 * network — `apps/worker-ai/worker_ai/llm` does that, against its own Python
 * mirror of these same strings (the same split as `translate.ts`/
 * `translate/providers/prompts.py`, CONTRACTS "all AI runs in apps/worker-ai").
 *
 * The registry exists so the eval runner, the admin console and a future
 * TypeScript caller can reason about "what prompt produced this output"
 * without shelling out to Python, and so a version bump is a single constant
 * change reviewers can diff.
 */
import type { z } from "zod";

/** One transcript segment as the templates read it — language-agnostic. */
export interface PromptTranscriptSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker?: string;
}

/** The only transcript facts a template may see (PII minimisation, brief §2). */
export interface PromptTranscriptInput {
  readonly language: string;
  /** Media title, if the project has one. Never a user's name or handle. */
  readonly mediaTitle?: string;
  readonly segments: readonly PromptTranscriptSegment[];
  readonly durationMs: number;
}

export interface TemplateMessages {
  readonly system: string;
  readonly user: string;
}

export interface TemplateDefinition<Input, Output> {
  readonly id: string;
  /** `"<id>@<n>"`, e.g. `"chapters@1"` — bump on any prompt or schema change. */
  readonly version: string;
  readonly purpose: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly build: (input: Input) => TemplateMessages;
}

/** `templateId@version`, the string the API and worker persist and compare. */
export function templateKey(def: TemplateDefinition<unknown, unknown>): string {
  return def.version;
}
