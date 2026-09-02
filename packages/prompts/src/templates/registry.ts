/**
 * The template registry: every LLM feature template, keyed by id, with the
 * version currently in force. `apps/api`'s insights module and the eval
 * runner both resolve templates through this module rather than importing
 * `chapters.ts` etc. directly, so adding a template only means adding it
 * here once.
 */
import { chaptersTemplate } from "./chapters.js";
import { hooksTemplate } from "./hooks.js";
import { keyphrasesTemplate } from "./keyphrases.js";
import { summaryTemplate } from "./summary.js";

import type { TemplateDefinition } from "./types.js";

export const TEMPLATE_REGISTRY = {
  chapters: chaptersTemplate,
  summary: summaryTemplate,
  hooks: hooksTemplate,
  keyphrases: keyphrasesTemplate,
} as const;

export type TemplateRegistryKind = keyof typeof TEMPLATE_REGISTRY;

export const INSIGHT_KINDS = ["chapters", "summary", "hooks"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

export function templateFor(kind: TemplateRegistryKind): TemplateDefinition<unknown, unknown> {
  return TEMPLATE_REGISTRY[kind] as TemplateDefinition<unknown, unknown>;
}

export function allTemplates(): readonly TemplateDefinition<unknown, unknown>[] {
  return Object.values(TEMPLATE_REGISTRY) as TemplateDefinition<unknown, unknown>[];
}
