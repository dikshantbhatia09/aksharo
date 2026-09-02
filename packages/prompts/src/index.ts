/**
 * `@montaj/prompts` — Versioned LLM prompts and their evals.
 *
 * B11 lands the template registry (chapters/summary/hooks/keyphrases),
 * schema-validated outputs, the filler lexicon and the eval runner
 * (`pnpm --filter @montaj/prompts eval`). A22's `translate.ts` predates this
 * framework (see that file's own doc comment) and is re-exported unchanged.
 * See README.md for what belongs here and docs/PLAN.md for scheduling.
 */

export {
  buildTranslateCaptionPrompt,
  TRANSLATE_CAPTION_PROMPT_VERSION,
  TRANSLATE_CAPTION_SYSTEM_PROMPT,
} from "./translate.js";
export type { TranslateCaptionPromptInput } from "./translate.js";

export {
  allTemplates,
  INSIGHT_KINDS,
  TEMPLATE_REGISTRY,
  templateFor,
} from "./templates/registry.js";
export type { InsightKind, TemplateRegistryKind } from "./templates/registry.js";
export type {
  PromptTranscriptInput,
  PromptTranscriptSegment,
  TemplateDefinition,
  TemplateMessages,
} from "./templates/types.js";
export { templateKey } from "./templates/types.js";

export { chaptersTemplate, maxChaptersFor, CHAPTERS_TEMPLATE_VERSION } from "./templates/chapters.js";
export type { Chapter, ChaptersInput, ChaptersOutput } from "./templates/chapters.js";

export { summaryTemplate, SUMMARY_MAX_CHARS, SUMMARY_LENGTHS, SUMMARY_TEMPLATE_VERSION } from "./templates/summary.js";
export type { SummaryInput, SummaryLength, SummaryOutput } from "./templates/summary.js";

export { hooksTemplate, HOOK_PLATFORMS, HOOKS_TEMPLATE_VERSION } from "./templates/hooks.js";
export type { HookPlatform, HooksInput, HooksOutput } from "./templates/hooks.js";

export { keyphrasesTemplate, KEYPHRASES_TEMPLATE_VERSION } from "./templates/keyphrases.js";
export type { Keyphrase, KeyphrasesInput, KeyphrasesOutput } from "./templates/keyphrases.js";

export { FILLER_LEXICON, fillersFor } from "./lexicon/fillers.js";

export { run as runEval, renderMarkdown as renderEvalMarkdown } from "./eval/runner.js";
export type { EvalCase, EvalReport } from "./eval/runner.js";
export { FIXTURES } from "./eval/fixtures.js";
export type { Fixture } from "./eval/fixtures.js";
export { mockGenerate } from "./eval/mock-provider.js";

/** Build-time identity of this package, used by diagnostics bundles and the admin console. */
export interface PackageInfo {
  readonly name: `@montaj/${string}`;
  /** Work package(s) that implement it. */
  readonly implementedBy: string;
  /** `false` until the owning work package lands. */
  readonly implemented: boolean;
}

export const PACKAGE_INFO: PackageInfo = {
  name: "@montaj/prompts",
  implementedBy: "B11 (prompts), D08 (eval harness)",
  implemented: true,
};
