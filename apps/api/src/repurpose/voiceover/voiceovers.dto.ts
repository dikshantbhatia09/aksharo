import { z } from "zod";

import { VOICEOVER_LIMITS, VoiceoverSpeakerSchema } from "@montaj/repurpose-contracts";

import { zodDto } from "../../common/index.js";

/**
 * `POST /repurpose/runs/{runId}/clips/{clipId}/voiceovers` (2026-10-01): the
 * words to say (the clip's hook when left out) and the stock voice to say
 * them in (Anushka when left out). The language is the clip's own, never the
 * request's: a voice-over is the clip's hook, in the clip's language.
 */
export const createVoiceoverSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(VOICEOVER_LIMITS.minTextChars)
    .max(VOICEOVER_LIMITS.maxTextChars)
    .optional(),
  speaker: VoiceoverSpeakerSchema.optional(),
});
export class CreateVoiceoverDto extends zodDto(createVoiceoverSchema) {}
export type CreateVoiceoverInput = z.infer<typeof createVoiceoverSchema>;
