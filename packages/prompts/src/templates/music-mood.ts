/**
 * `music-mood@1` (D05 follow-up, brief §2) — per-sentence sentiment scores
 * for `worker_ai.passes.music.analysis.detect_sections`'s own `sentiment_by_ms`
 * input, through B11's LLM client seam instead of the lexicon stub
 * `passes.service.ts`'s old `sentimentCuesOf` used to compute in `apps/api`
 * (CONTRACTS "all AI runs in apps/worker-ai" — the call now happens in
 * `worker_ai.passes.music.sentiment`, this template only defines its shape).
 *
 * One score per input `segments[]` entry, `-1` (negative) to `1` (positive),
 * `0` neutral — never free text, never a mood label itself (`analysis.py`'s
 * own `classify_mood` rule table still owns the (sentiment, energy) ->
 * taxonomy mapping; this template only supplies the sentiment half).
 */
import { z } from "zod";

import { GUARDRAIL_PREAMBLE, renderTranscriptBlock } from "./common.js";

import type { PromptTranscriptInput, TemplateDefinition, TemplateMessages } from "./types.js";

export const MUSIC_MOOD_TEMPLATE_VERSION = "music-mood@1";

export const MusicMoodInputSchema = z.object({
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
export type MusicMoodInput = z.infer<typeof MusicMoodInputSchema>;

export const MusicMoodScoreSchema = z.object({
  /** Index into the request's `segments[]`, 0-based. */
  index: z.number().int().min(0),
  sentiment: z.number().min(-1).max(1),
});
export type MusicMoodScore = z.infer<typeof MusicMoodScoreSchema>;

export const MusicMoodOutputSchema = z
  .object({ scores: z.array(MusicMoodScoreSchema) })
  .refine((v) => new Set(v.scores.map((s) => s.index)).size === v.scores.length, {
    message: "each segment index must appear at most once in scores",
    path: ["scores"],
  });
export type MusicMoodOutput = z.infer<typeof MusicMoodOutputSchema>;

function buildMusicMoodMessages(input: MusicMoodInput): TemplateMessages {
  const system =
    "You score the emotional sentiment of each sentence of a creator's video " +
    "transcript, for picking background music that matches the mood. " +
    GUARDRAIL_PREAMBLE +
    ' Reply with strict JSON only: {"scores":[{"index":number,"sentiment":number}]}. ' +
    "One entry per transcript line, in any order, `index` matching the line's " +
    "bracketed number. `sentiment` is a number from -1 (negative/sad/tense) to " +
    "1 (positive/upbeat/happy), 0 for neutral — never a word or label, only the number.";
  const user = renderTranscriptBlock(input as PromptTranscriptInput);
  return { system, user };
}

export const musicMoodTemplate: TemplateDefinition<MusicMoodInput, MusicMoodOutput> = {
  id: "music-mood",
  version: MUSIC_MOOD_TEMPLATE_VERSION,
  purpose: "Per-sentence sentiment scores for the music pass's mood classifier (D05).",
  inputSchema: MusicMoodInputSchema,
  outputSchema: MusicMoodOutputSchema,
  maxTokens: 1024,
  temperature: 0.1,
  build: buildMusicMoodMessages,
};
