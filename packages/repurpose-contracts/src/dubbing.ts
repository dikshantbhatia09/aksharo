import { z } from "zod";

import { VIDEO_SHAPES, type VideoShape } from "./formats.js";
import { REPURPOSE_SCHEMA_VERSION, UlidSchema } from "./schema.js";

/**
 * Dubbing (2026-10-04): a clip in other Indian languages, in the speaker's own
 * voice, with captions in the new language.
 *
 * Two queues, one vendor call:
 *
 *   * `ai.dub@1` (worker-ai) sends the clip's CLEAN 9:16 video to Sarvam's
 *     Dubbing API (Beta) - never a captioned video, whose burned captions are
 *     in the wrong language - as ONE vendor job for every language the person
 *     asked for, polls it, and files each language's dubbed audio and SRT in
 *     the derived store. The same queue carries `action: "cancel"`, which stops
 *     a vendor job whose dub the person cancelled.
 *   * `media.dub@1` (worker-media) lays one language's dubbed audio under one
 *     shape's clean video: the picture stream-copied, the audio padded or cut
 *     to the picture's length. The API files the result as that language's
 *     project for the shape, and the ordinary media pipeline takes it from there.
 *
 * **Cost safety is the contract's first job.** The vendor charges per minute
 * per language, so a worker must never start a second vendor job for one
 * attempt: before it starts the job it records the vendor's job id on its own
 * `jobs` row (the progress callback's `checkpoint`, {@link DubCheckpointSchema}),
 * and every later attempt - a BullMQ retry, a stalled job picked up again, a
 * person's Retry - resumes THAT job (`resumeVendorJobId`) unless it has
 * definitively failed.
 *
 * As with every repurposing queue the worker revalidates what it is given:
 * every key it reads or writes must be one of the dub's own (the patterns
 * below), so a payload cannot point it at an original, a face track or another
 * workspace's files.
 */

/**
 * The languages Sarvam dubs, as its API spells them (checked 2026-09-29).
 * Odia is `or-IN` here, where Sarvam's speech-to-text says `od-IN`.
 */
export const DUB_LANGUAGES = [
  "en-IN",
  "hi-IN",
  "bn-IN",
  "gu-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "or-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
  "as-IN",
] as const;
export type DubLanguage = (typeof DUB_LANGUAGES)[number];
export const DubLanguageSchema = z.enum(DUB_LANGUAGES);

/** What a person reads for each language. */
export const DUB_LANGUAGE_NAMES: Readonly<Record<DubLanguage, string>> = Object.freeze({
  "en-IN": "English",
  "hi-IN": "Hindi",
  "bn-IN": "Bengali",
  "gu-IN": "Gujarati",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "mr-IN": "Marathi",
  "or-IN": "Odia",
  "pa-IN": "Punjabi",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
  "as-IN": "Assamese",
});

/** The bounds one dub is held to, whatever the request says. */
export const DUB_LIMITS = Object.freeze({
  /** The vendor refuses less than a second of speech. */
  minDurationMs: 1_000,
  /** The vendor's own ceiling on this plan (an hour); a clip is three minutes at most. */
  maxDurationMs: 60 * 60_000,
  /** 1-10 speakers, or -1 to let the vendor count them. */
  maxSpeakers: 10,
  /** Every language but the clip's own. */
  maxLanguages: DUB_LANGUAGES.length - 1,
  /** A dubbed audio file larger than this is refused rather than stored. */
  maxAudioBytes: 200 * 1024 * 1024,
  /** Subtitles for three minutes are a few KB; this is a runaway guard. */
  maxCaptionsBytes: 2 * 1024 * 1024,
});

/** The audio file types the vendor's audio export is filed as, by what its bytes are. */
export const DUB_AUDIO_EXTENSIONS = [
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "flac",
  "webm",
] as const;

/*
 * The key patterns are written out in full rather than assembled from the
 * lists above, so what a worker may touch is readable in one place; the tests
 * hold them to the language list, the audio types and the shapes.
 */

/** `ws/{ws}/p/{sourceProject}/repurpose/{run}/dubs/{dub}`: one dub's folder. */
export const DUB_FOLDER_PATTERN =
  /^ws\/[0-9A-HJKMNP-TV-Z]{26}\/p\/[0-9A-HJKMNP-TV-Z]{26}\/repurpose\/[0-9A-HJKMNP-TV-Z]{26}\/dubs\/[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A file inside a dub's folder: a language's dubbed audio, its captions, or
 * one shape's dubbed video. Nothing else is ever read or written for a dub.
 */
export const DUB_KEY_PATTERN =
  /^ws\/[0-9A-HJKMNP-TV-Z]{26}\/p\/[0-9A-HJKMNP-TV-Z]{26}\/repurpose\/[0-9A-HJKMNP-TV-Z]{26}\/dubs\/[0-9A-HJKMNP-TV-Z]{26}\/(?:en|hi|bn|gu|kn|ml|mr|or|pa|ta|te|as)-IN\/(?:audio\.(?:mp3|wav|m4a|aac|ogg|opus|flac|webm)|captions\.srt|(?:9x16|4x5|1x1|16x9)\.mp4)$/;

/**
 * A clip's clean video in one shape (`media.clip`'s mezzanine): `master.mp4`
 * for 9:16, `master-4x5.mp4` and so on for the others.
 */
export const CLIP_VIDEO_KEY_PATTERN =
  /^ws\/[0-9A-HJKMNP-TV-Z]{26}\/p\/[0-9A-HJKMNP-TV-Z]{26}\/repurpose\/[0-9A-HJKMNP-TV-Z]{26}\/clips\/[0-9A-HJKMNP-TV-Z]{26}\/master(?:-(?:4x5|1x1|16x9))?\.mp4$/;

const DubFolderSchema = z.string().max(200).regex(DUB_FOLDER_PATTERN);
const DubKeySchema = z.string().max(240).regex(DUB_KEY_PATTERN);
const ClipVideoKeySchema = z.string().max(240).regex(CLIP_VIDEO_KEY_PATTERN);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * The vendor's job id: it goes into the vendor's URL paths, so only the
 * characters an id is made of are accepted (Sarvam's are UUIDs).
 */
export const VendorJobIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * `ai.dub@1`, `action: "dub"`: one vendor job for every language of one
 * request. `resumeVendorJobId` is set when an earlier attempt of this dub
 * started a vendor job that has not definitively failed: the worker resumes
 * polling it and never starts another.
 */
export const DubRunPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
    action: z.literal("dub"),
    runId: UlidSchema,
    clipId: UlidSchema,
    dubId: UlidSchema,
    /** The clip's clean 9:16 video, in the derived store. */
    source: z.strictObject({
      key: ClipVideoKeySchema,
      contentType: z.literal("video/mp4"),
    }),
    /** Its length, as its probe measured it; the price is worked out on this. */
    durationMs: z.int().min(DUB_LIMITS.minDurationMs).max(DUB_LIMITS.maxDurationMs),
    sourceLanguage: DubLanguageSchema,
    targetLanguages: z.array(DubLanguageSchema).min(1).max(DUB_LIMITS.maxLanguages),
    /** 1-10, or -1: let the vendor count them. */
    speakers: z.int().min(-1).max(DUB_LIMITS.maxSpeakers),
    /** Where each language's files go: `{prefix}/{language}/audio.{ext}` and `/captions.srt`. */
    destinationPrefix: DubFolderSchema,
    resumeVendorJobId: VendorJobIdSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.speakers === 0) {
      context.addIssue({ code: "custom", path: ["speakers"], message: "1-10, or -1." });
    }
    if (new Set(value.targetLanguages).size !== value.targetLanguages.length) {
      context.addIssue({
        code: "custom",
        path: ["targetLanguages"],
        message: "A language is asked for once.",
      });
    }
    if (value.targetLanguages.includes(value.sourceLanguage)) {
      context.addIssue({
        code: "custom",
        path: ["targetLanguages"],
        message: "A clip is not dubbed into its own language.",
      });
    }
  });

/** `ai.dub@1`, `action: "cancel"`: stop a vendor job whose dub the person cancelled. */
export const DubCancelPayloadSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  action: z.literal("cancel"),
  dubId: UlidSchema,
  vendorJobId: VendorJobIdSchema,
});

export const AiDubPayloadSchema = z.discriminatedUnion("action", [
  DubRunPayloadSchema,
  DubCancelPayloadSchema,
]);

/**
 * One language's outcome. `ready` carries both files; `failed` says why the
 * vendor produced none for it (a `partial_failure` job, an export that failed).
 */
export const DubTrackSchema = z
  .strictObject({
    language: DubLanguageSchema,
    status: z.enum(["ready", "failed"]),
    audio: z
      .strictObject({
        key: DubKeySchema,
        contentType: z.string().min(1).max(100),
        sizeBytes: z.int().positive().max(DUB_LIMITS.maxAudioBytes),
      })
      .optional(),
    captions: z
      .strictObject({
        key: DubKeySchema,
        sizeBytes: z.int().nonnegative().max(DUB_LIMITS.maxCaptionsBytes),
      })
      .optional(),
    reason: z.string().max(300).optional(),
  })
  .superRefine((value, context) => {
    if (value.status === "ready" && (value.audio === undefined || value.captions === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A ready language carries its audio and its captions.",
      });
    }
  });

export const DubRunResultSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
    action: z.literal("dub"),
    dubId: UlidSchema,
    vendorJobId: VendorJobIdSchema,
    vendorStatus: z.enum(["completed", "partial_failure"]),
    tracks: z.array(DubTrackSchema).min(1).max(DUB_LIMITS.maxLanguages),
  })
  .superRefine((value, context) => {
    const languages = value.tracks.map((track) => track.language);
    if (new Set(languages).size !== languages.length) {
      context.addIssue({ code: "custom", path: ["tracks"], message: "One track per language." });
    }
  });

export const DubCancelResultSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  action: z.literal("cancel"),
  dubId: UlidSchema,
  vendorJobId: VendorJobIdSchema,
  /** False when the vendor had already finished or forgotten the job: nothing left to stop. */
  cancelled: z.boolean(),
});

export const AiDubResultSchema = z.discriminatedUnion("action", [
  DubRunResultSchema,
  DubCancelResultSchema,
]);

/**
 * What the worker records on its `jobs` row (the progress callback's
 * `checkpoint`) the moment the vendor's job exists, and again as it moves on:
 * `created` (not yet uploaded), `uploaded` (the video is there, not started),
 * `started` (the vendor may be charging). Every later attempt reads it back from
 * its first progress answer and resumes that job.
 */
export const DUB_VENDOR_PHASES = ["created", "uploaded", "started"] as const;
export type DubVendorPhase = (typeof DUB_VENDOR_PHASES)[number];
export const DubCheckpointSchema = z.strictObject({
  vendorJobId: VendorJobIdSchema,
  vendorPhase: z.enum(DUB_VENDOR_PHASES),
});

/**
 * `media.dub@1`: one language's dubbed audio laid under one shape's clean
 * video. `originalBedDb` keeps the clip's own sound under the dub, that many dB
 * down; absent, the dub replaces it (whether the vendor's audio carries the
 * background is to be confirmed live, so both are possible).
 */
export const MediaDubPayloadSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  runId: UlidSchema,
  clipId: UlidSchema,
  dubId: UlidSchema,
  language: DubLanguageSchema,
  shape: z.enum(VIDEO_SHAPES),
  /** The shape's clean video (derived store) and its measured length. */
  video: z.strictObject({
    key: ClipVideoKeySchema,
    durationMs: z.int().positive().max(DUB_LIMITS.maxDurationMs),
  }),
  /** The language's dubbed audio (derived store). */
  audio: z.strictObject({ key: DubKeySchema }),
  destination: z.strictObject({ bucket: z.enum(["s3", "r2"]), key: DubKeySchema }),
  originalBedDb: z.number().min(-60).max(0).optional(),
});

export const MediaDubResultSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  dubId: UlidSchema,
  clipId: UlidSchema,
  language: DubLanguageSchema,
  shape: z.enum(VIDEO_SHAPES),
  key: DubKeySchema,
  checksum: Sha256Schema,
  sizeBytes: z.int().positive().max(10_000_000_000),
  /** The dubbed video's measured length: the picture's. */
  durationMs: z.int().positive(),
  /** The dubbed audio's own length, as delivered by the vendor. */
  audioDurationMs: z.int().nonnegative(),
  /** How the audio was fitted to the picture: as it was, padded with silence, or cut. */
  fit: z.enum(["exact", "padded", "trimmed"]),
  adjustMs: z.int().nonnegative(),
  /** Whether the clip's own sound was kept under the dub. */
  mixed: z.boolean(),
});

export type DubRunPayload = z.infer<typeof DubRunPayloadSchema>;
export type DubCancelPayload = z.infer<typeof DubCancelPayloadSchema>;
export type AiDubPayload = z.infer<typeof AiDubPayloadSchema>;
export type DubTrack = z.infer<typeof DubTrackSchema>;
export type DubRunResult = z.infer<typeof DubRunResultSchema>;
export type DubCancelResult = z.infer<typeof DubCancelResultSchema>;
export type AiDubResult = z.infer<typeof AiDubResultSchema>;
export type DubCheckpoint = z.infer<typeof DubCheckpointSchema>;
export type MediaDubPayload = z.infer<typeof MediaDubPayloadSchema>;
export type MediaDubResult = z.infer<typeof MediaDubResultSchema>;

/** `9:16` → `9x16`: how a shape is spelled in keys. */
export function shapeSlug(shape: VideoShape): string {
  return shape.replace(":", "x");
}

/** One dub's folder, under the run's source project (so it is purged with it). */
export function dubFolder(input: {
  readonly workspaceId: string;
  readonly sourceProjectId: string;
  readonly runId: string;
  readonly dubId: string;
}): string {
  return `ws/${input.workspaceId}/p/${input.sourceProjectId}/repurpose/${input.runId}/dubs/${input.dubId}`;
}

/** One shape's dubbed video in one language, inside the dub's folder. */
export function dubVideoKey(folder: string, language: DubLanguage, shape: VideoShape): string {
  return `${folder}/${language}/${shapeSlug(shape)}.mp4`;
}

/** Where one language's files must be: the worker's result is held to it. */
export function dubLanguageFolder(folder: string, language: DubLanguage): string {
  return `${folder}/${language}/`;
}

/** One vendor job per attempt of a dub: a retry never dedupes onto the one that failed. */
export function aiDubJobKey(dubId: string, attempt: number): string {
  return `ai.dub:${dubId}:${String(attempt)}`;
}

/** The job that stops a cancelled dub's vendor job: one per vendor job. */
export function aiDubCancelJobKey(dubId: string, vendorJobId: string): string {
  return `ai.dub.cancel:${dubId}:${vendorJobId}`;
}

/** One language in one shape: a failed mux is asked again under the same key. */
export function mediaDubJobKey(dubId: string, language: DubLanguage, shape: VideoShape): string {
  return `media.dub:${dubId}:${language}:${shapeSlug(shape)}`;
}
