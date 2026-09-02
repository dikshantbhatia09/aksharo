/**
 * `chapters.v1` — YouTube-style chapters from a transcript (brief §1, F-206).
 *
 * Rules the schema and the eval's automatic checks enforce together:
 * - `startMs` is snapped to a segment boundary (never a mid-word timestamp).
 * - at most 12 chapters for a transcript of 30 minutes or less (a longer one
 *   is allowed proportionally more, capped at 24).
 * - titles are at most 60 characters.
 * - the chapter language follows the transcript's; Hinglish stays Hinglish
 *   (never translated to Hindi or English) — see `input.language === "hi-Latn"`
 *   convention shared with A11/A22.
 */
import { z } from "zod";

import { GUARDRAIL_PREAMBLE, renderTranscriptBlock } from "./common.js";

import type { PromptTranscriptInput, TemplateDefinition, TemplateMessages } from "./types.js";

export const CHAPTERS_TEMPLATE_VERSION = "chapters@1";

export const ChapterSchema = z.object({
  startMs: z.number().int().min(0),
  title: z.string().min(1).max(60),
});
export type Chapter = z.infer<typeof ChapterSchema>;

export const ChaptersInputSchema = z.object({
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
export type ChaptersInput = z.infer<typeof ChaptersInputSchema>;

export const ChaptersOutputSchema = z
  .object({
    chapters: z.array(ChapterSchema).min(1),
  })
  .refine(
    (value) =>
      value.chapters.every((c, i) => i === 0 || c.startMs > (value.chapters[i - 1]?.startMs ?? -1)),
    {
      message: "chapters must be strictly ordered by startMs",
      path: ["chapters"],
    },
  );
export type ChaptersOutput = z.infer<typeof ChaptersOutputSchema>;

/** Max chapter count: 12 up to 30 minutes, +1 per additional 10 minutes, capped at 24. */
export function maxChaptersFor(durationMs: number): number {
  const minutes = durationMs / 60_000;
  if (minutes <= 30) return 12;
  const extra = Math.ceil((minutes - 30) / 10);
  return Math.min(24, 12 + extra);
}

function buildChaptersMessages(input: ChaptersInput): TemplateMessages {
  const cap = maxChaptersFor(input.durationMs);
  const system =
    "You are an assistant that writes YouTube-style chapter markers for a creator's " +
    "video, from its transcript. " +
    GUARDRAIL_PREAMBLE +
    " Reply with strict JSON only: " +
    '{"chapters":[{"startMs":number,"title":string}]}. ' +
    `Produce at most ${String(cap)} chapters, ordered by startMs ascending, the first ` +
    "starting at or near 0. Each title is at most 60 characters, written in the " +
    "SAME language and script as the transcript (if the transcript mixes Hindi " +
    'words in Latin script with English — "Hinglish" — write titles the same ' +
    "way; never translate to pure Hindi or pure English). Pick startMs values " +
    "that land on a topic change; they will be snapped to the nearest transcript " +
    "segment automatically, so approximate values are fine.";
  const user = renderTranscriptBlock(input as PromptTranscriptInput);
  return { system, user };
}

export const chaptersTemplate: TemplateDefinition<ChaptersInput, ChaptersOutput> = {
  id: "chapters",
  version: CHAPTERS_TEMPLATE_VERSION,
  purpose: "YouTube-style chapters snapped to transcript segment boundaries.",
  inputSchema: ChaptersInputSchema,
  outputSchema: ChaptersOutputSchema,
  maxTokens: 1024,
  temperature: 0.3,
  build: buildChaptersMessages,
};
