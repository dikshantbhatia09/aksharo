/**
 * `summary.v1` — three summary lengths of a transcript (brief §1, F-206).
 */
import { z } from "zod";

import { GUARDRAIL_PREAMBLE, renderTranscriptBlock } from "./common.js";

import type { PromptTranscriptInput, TemplateDefinition, TemplateMessages } from "./types.js";

export const SUMMARY_TEMPLATE_VERSION = "summary@1";

export const SUMMARY_LENGTHS = ["short", "medium", "long"] as const;
export type SummaryLength = (typeof SUMMARY_LENGTHS)[number];

/** Soft character caps the eval's length check applies per length. */
export const SUMMARY_MAX_CHARS: Readonly<Record<SummaryLength, number>> = {
  short: 240,
  medium: 600,
  long: 1_200,
};

export const SummaryInputSchema = z.object({
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
});
export type SummaryInput = z.infer<typeof SummaryInputSchema>;

export const SummaryOutputSchema = z.object({
  short: z.string().min(1).max(SUMMARY_MAX_CHARS.short),
  medium: z.string().min(1).max(SUMMARY_MAX_CHARS.medium),
  long: z.string().min(1).max(SUMMARY_MAX_CHARS.long),
});
export type SummaryOutput = z.infer<typeof SummaryOutputSchema>;

function buildSummaryMessages(input: SummaryInput): TemplateMessages {
  const system =
    "You write summaries of a creator's video from its transcript, at three " +
    "lengths at once. " +
    GUARDRAIL_PREAMBLE +
    " Reply with strict JSON only: " +
    '{"short":string,"medium":string,"long":string}. ' +
    `"short" is at most ${String(SUMMARY_MAX_CHARS.short)} characters (one or two ` +
    `sentences), "medium" at most ${String(SUMMARY_MAX_CHARS.medium)} characters ` +
    `(a paragraph), "long" at most ${String(SUMMARY_MAX_CHARS.long)} characters ` +
    "(a few paragraphs covering the main points in order). Write in the SAME " +
    "language and script as the transcript; if it mixes Hindi words in Latin " +
    "script with English (Hinglish), write the summary the same way.";
  const user = renderTranscriptBlock(input as PromptTranscriptInput);
  return { system, user };
}

export const summaryTemplate: TemplateDefinition<SummaryInput, SummaryOutput> = {
  id: "summary",
  version: SUMMARY_TEMPLATE_VERSION,
  purpose: "Three-length summary of a transcript.",
  inputSchema: SummaryInputSchema,
  outputSchema: SummaryOutputSchema,
  maxTokens: 1536,
  temperature: 0.4,
  build: buildSummaryMessages,
};
