import { z } from "zod";

import { REPURPOSE_SCHEMA_VERSION, UlidSchema } from "./schema.js";

/**
 * The voice-over hook (2026-10-01, OpusClip parity wave 4): a short spoken line
 * at the start of a clip - its hook (`copy.hook`) read aloud by a synthetic
 * voice in the run's language - with the clip's own sound pulled down under it.
 *
 * One queue, one vendor call:
 *
 *   * `ai.voiceover@1` (worker-ai) sends the hook's words to Sarvam's
 *     text-to-speech API (`bulbul`) and files the WAV it answers with in the
 *     derived store, at the one key the payload names. That is all the worker
 *     does: the API then puts the voice-over on every shape's editing document
 *     as an accepted `sfx` item (`@montaj/edg` `voiceoverPass`), so the cloud
 *     render, the browser export and the editor all play it from the same place
 *     and nothing is baked into the clip's media.
 *
 * **Cost safety.** Text-to-speech is one synchronous call with no vendor job
 * to resume, so the only way to pay twice is a retry after the vendor answered.
 * The worker therefore records what it stored on its own `jobs` row (the
 * progress callback's `checkpoint`, {@link VoiceoverCheckpointSchema}) the
 * moment the file is in the store, and every later attempt that finds that
 * checkpoint - and the file still there - answers from it without calling the
 * vendor. A call whose answer was lost in flight is the one case that can be
 * paid twice, and a hook is at most {@link VOICEOVER_LIMITS}`.maxTextChars`
 * characters (well under a rupee).
 *
 * As with every repurposing queue the worker revalidates what it is given: the
 * one key it writes must match {@link VOICEOVER_KEY_PATTERN}, so a payload
 * cannot point it at an original, a face track or another workspace's files.
 */

/**
 * The languages Sarvam's text-to-speech speaks, as its API spells them
 * (`bulbul:v2`). Odia is `od-IN` here, where the dubbing API says `or-IN`.
 */
export const VOICEOVER_LANGUAGES = [
  "en-IN",
  "hi-IN",
  "bn-IN",
  "gu-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
] as const;
export type VoiceoverLanguage = (typeof VOICEOVER_LANGUAGES)[number];
export const VoiceoverLanguageSchema = z.enum(VOICEOVER_LANGUAGES);

/** What a person reads for each language. */
export const VOICEOVER_LANGUAGE_NAMES: Readonly<Record<VoiceoverLanguage, string>> = Object.freeze({
  "en-IN": "English",
  "hi-IN": "Hindi",
  "bn-IN": "Bengali",
  "gu-IN": "Gujarati",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "mr-IN": "Marathi",
  "od-IN": "Odia",
  "pa-IN": "Punjabi",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
});

/**
 * The model's stock voices (`bulbul:v2`, checked 2026-10-01 against Sarvam's
 * published docs, not against the account). Stock voices only: nobody's own
 * voice is cloned, so a voice-over needs no consent tick the way a dub does.
 */
export const VOICEOVER_SPEAKERS = [
  "anushka",
  "manisha",
  "vidya",
  "arya",
  "abhilash",
  "karun",
  "hitesh",
] as const;
export type VoiceoverSpeaker = (typeof VOICEOVER_SPEAKERS)[number];
export const VoiceoverSpeakerSchema = z.enum(VOICEOVER_SPEAKERS);

/** What a person reads for each voice. */
export const VOICEOVER_SPEAKER_NAMES: Readonly<Record<VoiceoverSpeaker, string>> = Object.freeze({
  anushka: "Anushka (female)",
  manisha: "Manisha (female)",
  vidya: "Vidya (female)",
  arya: "Arya (female)",
  abhilash: "Abhilash (male)",
  karun: "Karun (male)",
  hitesh: "Hitesh (male)",
});

/** The model every voice-over is made with; a new model is a new contract field. */
export const VOICEOVER_MODEL = "bulbul:v2";

/** The bounds one voice-over is held to, whatever the request says. */
export const VOICEOVER_LIMITS = Object.freeze({
  /** A hook is a line, not a paragraph (the vendor takes 1,500). */
  maxTextChars: 300,
  minTextChars: 2,
  /** Speaking rate: the vendor's 1.0 is its natural pace. */
  minPace: 0.75,
  maxPace: 1.25,
  /** What the WAV is sampled at. */
  sampleRate: 22_050,
  /** 300 characters spoken slowly is about 25 s; a longer file is a runaway. */
  maxDurationMs: 30_000,
  /** 30 s of 16-bit mono at 22.05 kHz is 1.3 MB; this is a runaway guard. */
  maxAudioBytes: 8 * 1024 * 1024,
});

/** `ws/{ws}/p/{sourceProject}/repurpose/{run}/voiceovers/{voiceover}/hook.wav`. */
export const VOICEOVER_KEY_PATTERN =
  /^ws\/[0-9A-HJKMNP-TV-Z]{26}\/p\/[0-9A-HJKMNP-TV-Z]{26}\/repurpose\/[0-9A-HJKMNP-TV-Z]{26}\/voiceovers\/[0-9A-HJKMNP-TV-Z]{26}\/hook\.wav$/;

const VoiceoverKeySchema = z.string().max(240).regex(VOICEOVER_KEY_PATTERN);

/**
 * `ai.voiceover@1`: say `text` in `language` with `speaker`'s voice and file
 * the WAV at `destination.key`.
 */
export const AiVoiceoverPayloadSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  runId: UlidSchema,
  clipId: UlidSchema,
  voiceoverId: UlidSchema,
  text: z.string().trim().min(VOICEOVER_LIMITS.minTextChars).max(VOICEOVER_LIMITS.maxTextChars),
  language: VoiceoverLanguageSchema,
  speaker: VoiceoverSpeakerSchema,
  pace: z.number().min(VOICEOVER_LIMITS.minPace).max(VOICEOVER_LIMITS.maxPace),
  model: z.literal(VOICEOVER_MODEL),
  destination: z.strictObject({ key: VoiceoverKeySchema }),
});

/** What came back: the stored WAV, measured from its own header. */
export const AiVoiceoverResultSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  voiceoverId: UlidSchema,
  key: VoiceoverKeySchema,
  contentType: z.literal("audio/wav"),
  sizeBytes: z.int().positive().max(VOICEOVER_LIMITS.maxAudioBytes),
  durationMs: z.int().positive().max(VOICEOVER_LIMITS.maxDurationMs),
  /** Characters the vendor was paid for: what the price is worked out on. */
  characters: z.int().positive().max(VOICEOVER_LIMITS.maxTextChars),
  /** True when this attempt answered from an earlier one's stored file, without the vendor. */
  reused: z.boolean(),
});

/**
 * What the worker records on its `jobs` row once the WAV is in the store:
 * enough to answer again without calling the vendor.
 */
export const VoiceoverCheckpointSchema = z.strictObject({
  key: VoiceoverKeySchema,
  sizeBytes: z.int().positive().max(VOICEOVER_LIMITS.maxAudioBytes),
  durationMs: z.int().positive().max(VOICEOVER_LIMITS.maxDurationMs),
  characters: z.int().positive().max(VOICEOVER_LIMITS.maxTextChars),
});

export type AiVoiceoverPayload = z.infer<typeof AiVoiceoverPayloadSchema>;
export type AiVoiceoverResult = z.infer<typeof AiVoiceoverResultSchema>;
export type VoiceoverCheckpoint = z.infer<typeof VoiceoverCheckpointSchema>;

/** The voice-over's one file, under the run's source project (so it is purged with it). */
export function voiceoverAudioKey(input: {
  readonly workspaceId: string;
  readonly sourceProjectId: string;
  readonly runId: string;
  readonly voiceoverId: string;
}): string {
  return `ws/${input.workspaceId}/p/${input.sourceProjectId}/repurpose/${input.runId}/voiceovers/${input.voiceoverId}/hook.wav`;
}

/** One vendor call per attempt: a person's "Try again" never dedupes onto the one that failed. */
export function aiVoiceoverJobKey(voiceoverId: string, attempt: number): string {
  return `ai.voiceover:${voiceoverId}:${String(attempt)}`;
}
