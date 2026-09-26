import { z } from "zod";

import {
  AspectSchema,
  MillisecondsSchema,
  REPURPOSE_SCHEMA_VERSION,
  UlidSchema,
} from "./schema.js";

/**
 * Queue payload and result contracts for the three repurposing queues (REP-005):
 * `media.acquire@1`, `media.clip@1` and `ai.highlights@1`.
 *
 * `ai.highlights@1` has a Pydantic mirror in
 * `apps/worker-ai/worker_ai/highlights/contracts.py`. Both sides parse the SAME
 * JSON fixtures in `fixtures/`, and both assert the same literal field list, so a
 * field added on one side fails the other's test instead of being dropped in
 * transit.
 *
 * Two rules hold across all three:
 *
 *   * a worker revalidates everything it is given. A payload is a request, not a
 *     fact: a path, a duration or a MIME type produced by another internal
 *     component is still checked at the boundary (master plan §8.2);
 *   * a job key names the UNIT OF WORK, not the attempt, so a replay of the same
 *     work is deduplicated rather than done twice.
 */

const StorageKeySchema = z
  .string()
  .min(1)
  .max(512)
  // A key is built from ids, never from a filename: no traversal, no absolute
  // paths, no backslashes that a Windows worker would resolve differently.
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/, "Storage key must be a plain relative object key.")
  .refine((key) => !key.includes(".."), "Storage key must not traverse.");

const BucketSchema = z.enum(["s3", "r2"]);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const StorageObjectSchema = z.strictObject({
  bucket: BucketSchema,
  key: StorageKeySchema,
});

/**
 * `media.acquire@1` — bring an authorised external source into object storage.
 *
 * The URL is already normalised and the rights attestation already recorded when
 * this is enqueued: the worker's job is to fetch within limits, not to decide
 * whether it may. `limits` travels with the job because the plan that applied at
 * confirmation time is the plan that must apply when the job finally runs.
 */
export const MediaAcquirePayloadSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  runId: UlidSchema,
  projectId: UlidSchema,
  mediaId: UlidSchema,
  source: z.strictObject({
    kind: z.enum(["youtube_url", "direct_media_url"]),
    /** HTTPS, host-normalised, credentials stripped (§9.2). */
    normalizedUrl: z.url().refine((url) => url.startsWith("https://"), "Source must be HTTPS."),
    /** `youtube:{videoId}` — the dedupe identity, without tracking parameters. */
    sourceId: z.union([z.string().trim().min(1).max(200), z.null()]),
  }),
  destination: StorageObjectSchema,
  limits: z.strictObject({
    maxBytes: z.int().positive().max(10_000_000_000),
    maxDurationMs: z.int().positive().max(86_400_000),
    timeoutMs: z.int().positive().max(3_600_000),
  }),
});

export const MediaAcquireResultSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  mediaId: UlidSchema,
  bucket: BucketSchema,
  key: StorageKeySchema,
  filename: z.string().trim().min(1).max(255),
  mime: z.string().trim().min(3).max(100),
  sizeBytes: z.int().positive().max(10_000_000_000),
  checksum: Sha256Schema,
  sourceMetadata: z.strictObject({
    provider: z.string().trim().min(1).max(50),
    sourceId: z.union([z.string().trim().min(1).max(200), z.null()]),
    title: z.union([z.string().trim().max(500), z.null()]),
    channel: z.union([z.string().trim().max(200), z.null()]),
    durationMs: z.union([MillisecondsSchema, z.null()]),
  }),
  /** The pinned downloader that produced this, reported for support and audit. */
  toolVersion: z.string().trim().min(1).max(100),
  /**
   * The prober that measured what actually landed.
   *
   * Separate from {@link toolVersion} because they answer different questions and
   * fail differently: `toolVersion` says which downloader fetched the bytes,
   * this says which ffprobe produced the duration the plan's cap is then applied
   * to. When a source is accepted that should not have been, the second one is
   * the one worth knowing.
   */
  probeToolVersion: z.string().trim().min(1).max(100),
  /** True when the object already existed: a replay must not download twice. */
  deduplicated: z.boolean(),
});

/**
 * `media.clip@1` — cut one selected interval into a short mezzanine.
 *
 * `handleMs` is the edit handle kept on each side so the boundary stays adjustable
 * in the editor (§11.2). `effectiveStartMs`/`effectiveEndMs` in the result are what
 * the cut actually achieved, which is not always what was asked: a source can end
 * sooner than the requested handle allows.
 */
export const MediaClipPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
    runId: UlidSchema,
    candidateId: UlidSchema,
    clipId: UlidSchema,
    source: StorageObjectSchema,
    sourceDurationMs: z.int().positive(),
    startMs: MillisecondsSchema,
    endMs: z.int().positive(),
    handleMs: z.int().nonnegative().max(10_000),
    destination: StorageObjectSchema,
    profile: z.strictObject({
      container: z.literal("mp4"),
      videoCodec: z.literal("h264"),
      audioCodec: z.literal("aac"),
      /**
       * The mezzanine's output height (a 9:16 picture this tall, or the
       * source's own height if that is smaller). Was ignored until 2026-09-26:
       * every clip came out 720 x 1280.
       */
      maxHeight: z.int().positive().max(2160),
    }),
    /**
     * Where the 9:16 window sits across the source frame (2026-09-26). The API
     * decides it from the source's face track (`faces.json`, `ai.faces`): the
     * horizontal centre of the speaking face over the clip, as a fraction of
     * the source width. Absent means the frame centre, which is what every
     * clip got before - and what off-centre speakers were cut out by.
     */
    reframe: z
      .strictObject({
        centerX: z.number().min(0).max(1),
        /** `faces`: from the face track; `centre`: no usable faces. */
        basis: z.enum(["faces", "centre"]),
      })
      .optional(),
    profileVersion: z.string().trim().min(1).max(100),
    subtitles: z
      .array(
        z.strictObject({
          startMs: z.number(),
          endMs: z.number(),
          text: z.string(),
        }),
      )
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.endMs <= value.startMs) {
      context.addIssue({ code: "custom", path: ["endMs"], message: "Clip end must follow start." });
    }
    if (value.endMs > value.sourceDurationMs) {
      context.addIssue({
        code: "custom",
        path: ["endMs"],
        message: "Clip ends after the source does.",
      });
    }
  });

export const MediaClipResultSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
    clipId: UlidSchema,
    bucket: BucketSchema,
    key: StorageKeySchema,
    checksum: Sha256Schema,
    sizeBytes: z.int().positive().max(10_000_000_000),
    /** Measured by probing the output, never carried over from the request. */
    durationMs: z.int().positive(),
    effectiveStartMs: MillisecondsSchema,
    effectiveEndMs: z.int().positive(),
    /** The handles actually applied, which may be shorter than requested. */
    leadHandleMs: z.int().nonnegative().max(10_000),
    tailHandleMs: z.int().nonnegative().max(10_000),
    hasAudio: z.boolean(),
    deduplicated: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.effectiveEndMs <= value.effectiveStartMs) {
      context.addIssue({
        code: "custom",
        path: ["effectiveEndMs"],
        message: "Effective end must follow effective start.",
      });
    }
  });

/**
 * `ai.highlights@1` — rank bounded, deterministic windows.
 *
 * The payload pins a transcript REVISION, not just a transcript: re-running
 * against edited words is a different job with a different key, and caching a
 * result against the wrong revision is how a clip ends up cut on words that no
 * longer exist.
 */
export const HighlightsPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
    runId: UlidSchema,
    projectId: UlidSchema,
    transcriptId: UlidSchema,
    transcriptRevision: z.int().positive(),
    proxy: StorageObjectSchema,
    waveform: z.union([StorageObjectSchema, z.null()]),
    options: z.strictObject({
      count: z.int().min(1).max(20),
      minDurationMs: z.int().min(3_000).max(180_000),
      maxDurationMs: z.int().min(3_000).max(180_000),
      contentGoal: z.enum(["reach", "education", "authority", "engagement"]),
      /** The language to reason IN. Hinglish is `hi-Latn`, never flattened to en. */
      language: z.string().trim().min(2).max(64),
    }),
    promptVersion: z.string().trim().min(1).max(100),
    featureVersion: z.string().trim().min(1).max(100),
  })
  .superRefine((value, context) => {
    if (value.options.minDurationMs > value.options.maxDurationMs) {
      context.addIssue({
        code: "custom",
        path: ["options", "maxDurationMs"],
        message: "Maximum duration is below minimum.",
      });
    }
  });

/**
 * One proposal. The model selects an enumerated window id and explains itself; it
 * does not invent a timecode (§10.2 step 6). `windowId` is what makes that
 * checkable after the fact.
 */
export const HighlightProposalSchema = z
  .strictObject({
    windowId: z.string().trim().min(1).max(100),
    startMs: MillisecondsSchema,
    endMs: z.int().positive(),
    startWordId: z.string().trim().min(1).max(100),
    endWordId: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(160),
    transcriptExcerpt: z.string().max(2_000),
    potentialScore: z.int().min(0).max(100),
    scoreBreakdown: z.strictObject({
      hook: z.int().min(0).max(100),
      clarity: z.int().min(0).max(100),
      emotion: z.int().min(0).max(100),
      visualActivity: z.int().min(0).max(100),
      novelty: z.int().min(0).max(100),
      standaloneValue: z.int().min(0).max(100),
      safety: z.int().min(0).max(100),
    }),
    reasons: z
      .array(
        z.strictObject({
          label: z.enum([
            "hook",
            "clear_point",
            "emotion",
            "visual",
            "novelty",
            "standalone",
            "safety",
          ]),
          explanation: z.string().trim().min(1).max(240),
        }),
      )
      .min(1)
      .max(12),
  })
  .superRefine((value, context) => {
    const duration = value.endMs - value.startMs;
    if (duration < 3_000 || duration > 180_000) {
      context.addIssue({
        code: "custom",
        path: ["endMs"],
        message: "Proposal duration must be 3-180 seconds.",
      });
    }
  });

export const HighlightsResultSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  runId: UlidSchema,
  transcriptId: UlidSchema,
  transcriptRevision: z.int().positive(),
  /** Fewer, better candidates is a valid answer; padding with weak clips is not. */
  proposals: z.array(HighlightProposalSchema).max(20),
  /** Aggregate features only — never a face identity or an inferred trait. */
  featureVersion: z.string().trim().min(1).max(100),
  promptVersion: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  /** Windows considered before ranking, so a thin result is explainable. */
  windowsConsidered: z.int().nonnegative().max(10_000),
});

/**
 * Job keys. Each names the work, so the same work enqueued twice is one job.
 *
 * `media.acquire` keys on the normalised SOURCE rather than the media row: ten
 * pastes of the same URL into one run are one download (§9.5).
 */
export function mediaAcquireJobKey(runId: string, sourceFingerprint: string): string {
  return `media.acquire:${runId}:${sourceFingerprint}`;
}

/** Bounds and profile are in the key: re-cutting after a trim is new work. */
export function mediaClipJobKey(
  candidateId: string,
  boundsFingerprint: string,
  profileVersion: string,
): string {
  return `media.clip:${candidateId}:${boundsFingerprint}:${profileVersion}`;
}

/** The revision is in the key: an edited transcript is a different analysis. */
export function highlightsJobKey(
  runId: string,
  transcriptId: string,
  revision: number,
  configFingerprint: string,
): string {
  return `ai.highlights:${runId}:${transcriptId}:${String(revision)}:${configFingerprint}`;
}

/**
 * Storage keys (CONTRACTS §6 amendment 2026-09-15).
 *
 * Repurposing artefacts hang off the SOURCE project so they purge with it, and
 * every key keeps the `ws/{workspaceId}` prefix that object-level tenancy relies
 * on (§17.3).
 */
export function repurposeFeaturesKey(input: {
  workspaceId: string;
  sourceProjectId: string;
  runId: string;
  featureVersion: string;
}): string {
  return `ws/${input.workspaceId}/p/${input.sourceProjectId}/repurpose/${input.runId}/features/${input.featureVersion}.json`;
}

export function clipMasterKey(input: {
  workspaceId: string;
  sourceProjectId: string;
  runId: string;
  candidateId: string;
}): string {
  return `ws/${input.workspaceId}/p/${input.sourceProjectId}/repurpose/${input.runId}/clips/${input.candidateId}/master.mp4`;
}

/** The aspect families a run may request, as the materialiser enumerates them. */
export const RequestedAspectsSchema = z.array(AspectSchema).min(1).max(4);

export type MediaAcquirePayload = z.infer<typeof MediaAcquirePayloadSchema>;
export type MediaAcquireResult = z.infer<typeof MediaAcquireResultSchema>;
export type MediaClipPayload = z.infer<typeof MediaClipPayloadSchema>;
export type MediaClipResult = z.infer<typeof MediaClipResultSchema>;
export type HighlightsPayload = z.infer<typeof HighlightsPayloadSchema>;
export type HighlightProposal = z.infer<typeof HighlightProposalSchema>;
export type HighlightsResult = z.infer<typeof HighlightsResultSchema>;
