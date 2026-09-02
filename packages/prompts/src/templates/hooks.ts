/**
 * `hooks.v1` — 5 hooks, 5 titles, 10 hashtags, per-platform (brief §1, F-207).
 */
import { z } from "zod";

import { GUARDRAIL_PREAMBLE, renderTranscriptBlock } from "./common.js";

import type { PromptTranscriptInput, TemplateDefinition, TemplateMessages } from "./types.js";

export const HOOKS_TEMPLATE_VERSION = "hooks@1";

export const HOOK_PLATFORMS = ["youtube", "instagram", "tiktok"] as const;
export type HookPlatform = (typeof HOOK_PLATFORMS)[number];

export const HooksInputSchema = z.object({
  language: z.string().min(2),
  mediaTitle: z.string().max(200).optional(),
  durationMs: z.number().int().min(0),
  segments: z
    .array(
      z.object({
        startMs: z.number().int().min(0),
        endMs: z.number().int().min(0),
        text: z.string(),
        speaker: z.string().optional(),
      }),
    )
    .min(1),
  /** Tone parameter for regeneration (brief §4): default "energetic". */
  tone: z.enum(["energetic", "calm", "bold", "informative"]).default("energetic"),
});
export type HooksInput = z.infer<typeof HooksInputSchema>;

const PlatformVariantSchema = z.object({
  hooks: z.array(z.string().min(1).max(120)).length(5),
  titles: z.array(z.string().min(1).max(100)).length(5),
  hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]+$/u)).length(10),
});

export const HooksOutputSchema = z.object({
  youtube: PlatformVariantSchema,
  instagram: PlatformVariantSchema,
  tiktok: PlatformVariantSchema,
});
export type HooksOutput = z.infer<typeof HooksOutputSchema>;

function buildHooksMessages(input: HooksInput): TemplateMessages {
  const system =
    "You write short-form hooks, titles and hashtags for a creator's video, " +
    "from its transcript, for three platforms at once. " +
    GUARDRAIL_PREAMBLE +
    ` Tone: ${input.tone}.` +
    " Reply with strict JSON only, one key per platform " +
    '("youtube", "instagram", "tiktok"), each shaped ' +
    '{"hooks":[5 strings, <=120 chars],"titles":[5 strings, <=100 chars],' +
    '"hashtags":[10 strings, each starting with # and no spaces]}. ' +
    "Write in the SAME language and script as the transcript; if it mixes Hindi " +
    "words in Latin script with English (Hinglish), keep that mix. Every hashtag " +
    "must be built only from words that appear in the transcript or are the " +
    "media title, plus common platform hashtags for the topic.";
  const user = renderTranscriptBlock(input as PromptTranscriptInput);
  return { system, user };
}

export const hooksTemplate: TemplateDefinition<HooksInput, HooksOutput> = {
  id: "hooks",
  version: HOOKS_TEMPLATE_VERSION,
  purpose: "5 hooks + 5 titles + 10 hashtags per platform.",
  inputSchema: HooksInputSchema,
  outputSchema: HooksOutputSchema,
  maxTokens: 2048,
  temperature: 0.6,
  build: buildHooksMessages,
};
