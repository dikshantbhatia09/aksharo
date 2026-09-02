/**
 * `keyphrases.v1` — key phrases with transcript timestamps, for D06 (text FX
 * highlighting) to consume later. B11 only defines and evals the template;
 * wiring a consumer is D06's, out of this brief's scope.
 */
import { z } from "zod";

import { GUARDRAIL_PREAMBLE, renderTranscriptBlock } from "./common.js";

import type { PromptTranscriptInput, TemplateDefinition, TemplateMessages } from "./types.js";

export const KEYPHRASES_TEMPLATE_VERSION = "keyphrases@1";

export const KeyphrasesInputSchema = z.object({
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
  maxPhrases: z.number().int().min(1).max(50).default(20),
});
export type KeyphrasesInput = z.infer<typeof KeyphrasesInputSchema>;

export const KeyphraseSchema = z.object({
  phrase: z.string().min(1).max(80),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
});
export type Keyphrase = z.infer<typeof KeyphraseSchema>;

export const KeyphrasesOutputSchema = z
  .object({ keyphrases: z.array(KeyphraseSchema) })
  .refine((v) => v.keyphrases.every((k) => k.endMs >= k.startMs), {
    message: "each keyphrase's endMs must not precede its startMs",
    path: ["keyphrases"],
  });
export type KeyphrasesOutput = z.infer<typeof KeyphrasesOutputSchema>;

function buildKeyphrasesMessages(input: KeyphrasesInput): TemplateMessages {
  const system =
    "You extract the notable key phrases from a creator's video transcript, " +
    "each anchored to when it was said. " +
    GUARDRAIL_PREAMBLE +
    " Reply with strict JSON only: " +
    '{"keyphrases":[{"phrase":string,"startMs":number,"endMs":number}]}. ' +
    `At most ${String(input.maxPhrases)} phrases, each 1-6 words taken verbatim ` +
    "from the transcript, with the millisecond span where they were spoken.";
  const user = renderTranscriptBlock(input as PromptTranscriptInput);
  return { system, user };
}

export const keyphrasesTemplate: TemplateDefinition<KeyphrasesInput, KeyphrasesOutput> = {
  id: "keyphrases",
  version: KEYPHRASES_TEMPLATE_VERSION,
  purpose: "Key phrases anchored to transcript timestamps (for D06).",
  inputSchema: KeyphrasesInputSchema,
  outputSchema: KeyphrasesOutputSchema,
  maxTokens: 1024,
  temperature: 0.2,
  build: buildKeyphrasesMessages,
};
