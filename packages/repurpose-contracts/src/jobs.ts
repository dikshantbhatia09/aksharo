import { z } from "zod";

import { SplitScreenConfigSchema } from "./formats.js";
import {
  AspectSchema,
  CANDIDATE_REASON_LABELS,
  ClipCopySchema,
  DynamicReframeTrajectorySchema,
  ExcludeRangeSchema,
  MillisecondsSchema,
  REPURPOSE_SCHEMA_VERSION,
  UlidSchema,
  ViralityDiagnosticSchema,
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
/** `#RRGGBB`: nothing else reaches an ffmpeg filtergraph as a colour. */
const HexColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "A colour is #RRGGBB.");

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
    /**
     * `hosted_url` (2026-10-01): a Vimeo, Google Drive or Dropbox link, rebuilt
     * from its fingerprint. **Deploy worker-media before an api that sends
     * it**: an older worker refuses the kind (`media/unsupported`), so the
     * run fails with "that kind of link cannot be fetched yet" rather than
     * being fetched.
     */
    kind: z.enum(["youtube_url", "hosted_url", "direct_media_url"]),
    /** HTTPS, host-normalised, credentials stripped (§9.2). */
    normalizedUrl: z.url().refine((url) => url.startsWith("https://"), "Source must be HTTPS."),
    /**
     * `youtube:{videoId}` — the dedupe identity, without tracking parameters;
     * `vimeo:`, `gdrive:` or `dropbox:` for a `hosted_url` (`source-url.ts`).
     */
    sourceId: z.union([z.string().trim().min(1).max(200), z.null()]),
  }),
  destination: StorageObjectSchema,
  limits: z.strictObject({
    maxBytes: z.int().positive().max(10_000_000_000),
    /**
     * The longest SOURCE this job may fetch. With a {@link window} this is the
     * abuse ceiling (`maxSourceDurationMs`, 12 h), not the plan's allowance:
     * a longer source is cut down to the window instead of refused.
     */
    maxDurationMs: z.int().positive().max(86_400_000),
    timeoutMs: z.int().positive().max(3_600_000),
  }),
  /**
   * The part of the source to fetch (2026-09-27). Optional, so a job built
   * before it existed - and every short video - downloads the whole source.
   * When the source is longer than `maxMs`, the worker takes `maxMs` of it:
   * from `startMs` (`range`), from YouTube's most-replayed peak when the
   * metadata has one (`most_replayed`, falling back to the start), or from the
   * start (`first`). Downstream everything runs on the landed file's own clock;
   * the result's `section` says where that file sits in the source.
   */
  window: z
    .strictObject({
      maxMs: z.int().positive().max(86_400_000),
      startMs: MillisecondsSchema.optional(),
      policy: z.enum(["first", "most_replayed", "range"]),
    })
    .optional(),
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
    chapters: z
      .array(
        z.strictObject({
          title: z.string().trim().min(1).max(500),
          startSec: z.number().nonnegative(),
          endSec: z.number().nonnegative(),
        }),
      )
      .optional(),
    egressProxyNode: z.union([z.string().trim().max(100), z.null()]).optional(),
  }),
  /**
   * Where the landed file sits in the source, when only a window of it was
   * fetched (2026-09-27). Absent when the whole source landed.
   */
  section: z
    .strictObject({
      startMs: MillisecondsSchema,
      endMs: z.int().positive(),
      sourceDurationMs: z.int().positive(),
      policy: z.enum(["first", "most_replayed", "range"]),
    })
    .optional(),
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
 * How a clip's picture is laid out (2026-10-01, two-speaker layouts):
 * `single` is one window on the speaker, as every clip was before; `stacked`
 * gives each of two people side by side in the source half of the picture, one
 * above the other. Only a shape tall enough to hold two halves is stacked
 * ({@link STACKED_ASPECTS}).
 */
export const CLIP_LAYOUTS = ["single", "stacked", "fit"] as const;
export const ClipLayoutSchema = z.enum(CLIP_LAYOUTS);
export type ClipLayout = z.infer<typeof ClipLayoutSchema>;

/** The shapes a stacked cut is made in: 1:1 would squash two halves, and 16:9 needs none. */
export const STACKED_ASPECTS = ["9:16", "4:5"] as const;
export const FIT_ASPECTS = ["9:16", "4:5"] as const;

/**
 * One of the two people a stacked cut shows: where their face is, as
 * fractions of the source frame, and its height as a share of the source's
 * height, which sets how far the worker zooms in on them.
 */
export const StackedPersonSchema = z.strictObject({
  centerX: z.number().min(0).max(1),
  centerY: z.number().min(0).max(1),
  size: z.number().gt(0).max(1),
});
export type StackedPerson = z.infer<typeof StackedPersonSchema>;

/** The image types an audiogram's artwork may be (the brand kit's logo types). */
export const AUDIOGRAM_ARTWORK_FORMATS = ["png", "jpeg", "webp"] as const;

/**
 * A picture for a source that has none (2026-10-04, audiograms).
 *
 * An audio-only source - a podcast, a voice note, the bundled sample - used to
 * be cut into audio-only clips, and nothing after the cut could use them: the
 * cloud render draws over a video stream (`render/no-video-stream`), the image
 * formats are frames of a video, a compilation joins pictures, and the editor
 * could only say "audio only". With this, the cut draws a picture at the
 * shape's size instead: `background`, the `artwork` above where the captions
 * go (a cover the person gave with the run, else the brand kit's logo, else
 * none), and a live waveform of the clip's own audio in `accent`. Captions are
 * drawn later, by the render, as on any clip.
 *
 * Sent only when the API has probed the source and found no picture. The
 * artwork is an object in the derived store, in the clip's own workspace.
 */
export const AudiogramSchema = z.strictObject({
  background: HexColourSchema,
  accent: HexColourSchema,
  artwork: z
    .strictObject({
      key: StorageKeySchema,
      format: z.enum(AUDIOGRAM_ARTWORK_FORMATS),
    })
    .optional(),
});
export type Audiogram = z.infer<typeof AudiogramSchema>;

/**
 * Every field a `media.clip@1` payload may carry, in order (2026-10-04).
 *
 * `apps/worker-media` restates the payload rather than importing this package,
 * and refuses a payload with any field it does not know
 * (`processors/clip-payload.ts`), so an older worker says so loudly instead of
 * cutting a clip without what it was asked for. Its test reads this list out of
 * this file: a field added here and not there fails that test.
 */
export const MEDIA_CLIP_PAYLOAD_FIELDS = [
  "aspect",
  "audiogram",
  "candidateId",
  "clipId",
  "destination",
  "endMs",
  "handleMs",
  "profile",
  "profileVersion",
  "reframe",
  "runId",
  "schemaVersion",
  "source",
  "sourceDurationMs",
  "startMs",
  "subtitles",
] as const;

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
        /**
         * The speaking face's vertical centre (2026-09-29), for a source taller
         * than the shape being cut (a vertical video cut to 16:9, say); absent
         * keeps the band in the middle.
         */
        centerY: z.number().min(0).max(1).optional(),
        /** `faces`: from the face track; `centre`: no usable faces. */
        basis: z.enum(["faces", "centre"]),
        /**
         * `stacked` (2026-10-01): the two people in {@link people}, each in
         * half of the picture, the first on top. Absent is `single`, which is
         * every payload from before. `centerX` still names the dominant
         * speaker, so a worker that knows nothing of stacking frames them.
         */
        layout: ClipLayoutSchema.optional(),
        /** A stacked cut's two people, top half first (the left person, by default). */
        people: z.array(StackedPersonSchema).length(2).optional(),
        /**
         * Time-varying crop trajectory (Pillar 3 §01, Dynamic Active Speaker Tracking).
         * Smoothly pans and zooms the crop window when a single speaker moves beyond the deadband.
         */
        trajectory: DynamicReframeTrajectorySchema.optional(),
        /**
         * Dual crop coordinates for two-speaker vertical split-screen layout (Pillar 3 §02).
         */
        splitScreen: SplitScreenConfigSchema.optional(),
      })
      .superRefine((value, context) => {
        if (value.layout === "stacked" && value.people === undefined) {
          context.addIssue({
            code: "custom",
            path: ["people"],
            message: "A stacked cut names its two people.",
          });
        }
        if (value.layout !== "stacked" && value.people !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["people"],
            message: "Only a stacked cut names people.",
          });
        }
        if (
          value.trajectory !== undefined &&
          (value.layout === "stacked" || value.layout === "fit")
        ) {
          context.addIssue({
            code: "custom",
            path: ["trajectory"],
            message: "A dynamic trajectory applies only to a single-speaker cut.",
          });
        }
      })
      .optional(),
    /**
     * The shape to cut (2026-09-29): every clip is cut 9:16 first, then 4:5,
     * 1:1 and 16:9 for the other platforms. Absent means 9:16.
     */
    aspect: AspectSchema.optional(),
    /**
     * The picture to draw, for a source with none (2026-10-04,
     * {@link AudiogramSchema}). Absent on every cut of a source with a
     * picture, which is cut exactly as before.
     */
    audiogram: AudiogramSchema.optional(),
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
    if (
      value.reframe?.layout === "stacked" &&
      !(STACKED_ASPECTS as readonly string[]).includes(value.aspect ?? "9:16")
    ) {
      context.addIssue({
        code: "custom",
        path: ["reframe", "layout"],
        message: "Only a 9:16 or a 4:5 cut is stacked.",
      });
    }
    if (
      value.reframe?.layout === "fit" &&
      !(FIT_ASPECTS as readonly string[]).includes(value.aspect ?? "9:16")
    ) {
      context.addIssue({
        code: "custom",
        path: ["reframe", "layout"],
        message: "Only a 9:16 or a 4:5 cut is fitted.",
      });
    }
    if (value.audiogram !== undefined && (value.reframe?.layout === "stacked" || value.reframe?.layout === "fit")) {
      context.addIssue({
        code: "custom",
        path: ["reframe", "layout"],
        message: "An audiogram is one picture; it is never stacked or fitted.",
      });
    }
    const artwork = value.audiogram?.artwork;
    if (
      artwork !== undefined &&
      workspacePrefixOf(artwork.key) !== workspacePrefixOf(value.destination.key)
    ) {
      context.addIssue({
        code: "custom",
        path: ["audiogram", "artwork", "key"],
        message: "The artwork is not in this clip's workspace.",
      });
    }
  });

/** `ws/{workspaceId}/` of a key, or `null` for a key outside every workspace. */
function workspacePrefixOf(key: string): string | null {
  const match = /^ws\/[^/]+\//.exec(key);
  return match === null ? null : match[0];
}

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
    /**
     * What the cut's picture is (2026-10-04), said only for a payload that
     * asked for an `audiogram`: `audiogram` when the worker drew one, `source`
     * when the source turned out to have a picture of its own and was cut as
     * any video is. Absent for every other cut, so an API from before
     * audiograms, whose strict schema would refuse it, never sees it; and
     * absent from a worker from before them, which is how the API tells a cut
     * that ignored the `audiogram` it asked for (a clip with no picture) from
     * one that made it.
     */
    picture: z.enum(["source", "audiogram"]).optional(),
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

/** The platforms a posted clip's numbers come from (2026-10-05). */
export const PERFORMANCE_PLATFORMS = [
  "youtube",
  "instagram",
  "tiktok",
  "linkedin",
  "x",
  "facebook",
  "threads",
] as const;

/**
 * How a clip opens, as both sides classify it: a question, a number, the
 * viewer addressed ("you", "aap"), or a plain statement.
 */
export const HOOK_STYLES = ["question", "number", "you", "statement"] as const;

/** A post's count: a Postgres `integer`. */
const CountSchema = z.int().min(0).max(2_147_483_647);
const PostsSchema = z.int().min(1).max(1_000_000);

/**
 * What a workspace's posted clips say worked (2026-10-05): `ai.highlights@1`'s
 * `options.performance`, sent only once the workspace has enough measured
 * posts (`apps/api/src/repurpose/performance/steering-signal.ts`).
 *
 * Compact on purpose: its best clips' words (at most five), and - when the
 * numbers show a clear difference - the length band and the kind of opening
 * that did best, each with the number of posts behind it. The worker turns
 * it into a small, capped lift on the moments that resemble them, named in
 * the moment's reasons (`track_record`); it never changes which moments the
 * person's own steering allows (topic, length, skipped parts, the bar).
 */
export const PerformanceSignalSchema = z.strictObject({
  /** The posts with numbers this was worked out from. */
  basis: PostsSchema,
  /** The best clips, best first. */
  hits: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(160),
        /** Its on-screen hook, when it had one. */
        hook: z.string().trim().min(1).max(500).optional(),
        /** A little of what was said in it. */
        excerpt: z.string().trim().min(1).max(600).optional(),
        /** Its best post's views, and where. */
        views: CountSchema,
        platform: z.enum(PERFORMANCE_PLATFORMS),
      }),
    )
    .max(5),
  /** The length band that did clearly better than the rest. */
  length: z
    .strictObject({
      minMs: z.int().min(0).max(180_000),
      maxMs: z.int().min(3_000).max(180_000),
      posts: PostsSchema,
    })
    .refine((band) => band.maxMs > band.minMs, {
      message: "A length band must end after it starts.",
      path: ["maxMs"],
    })
    .optional(),
  /** The kind of opening that did clearly better than the rest. */
  hook: z.strictObject({ style: z.enum(HOOK_STYLES), posts: PostsSchema }).optional(),
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
      /** The most moments to return (Autopilot asks for up to 40, 2026-09-29). */
      count: z.int().min(1).max(40),
      /**
       * The bar a moment must clear to be returned at all, as a potential of
       * 0-1 (`potentialScore` / 100). Absent: the best `count`, however they
       * score - what every run before Autopilot's "only what can go viral" got.
       */
      minPotential: z.number().min(0).max(1).optional(),
      minDurationMs: z.int().min(3_000).max(180_000),
      maxDurationMs: z.int().min(3_000).max(180_000),
      contentGoal: z.enum(["reach", "education", "authority", "engagement"]),
      /** The language to reason IN. Hinglish is `hi-Latn`, never flattened to en. */
      language: z.string().trim().min(2).max(64),
      /** What the clips should be about, in the person's words (2026-09-29). */
      topic: z.string().trim().min(2).max(200).optional(),
      /** Parts of the source to take no clip from: an intro, an ad, an outro. */
      excludeRanges: z.array(ExcludeRangeSchema).max(20).optional(),
      /**
       * Write each proposal's copy (title, hook, description, hashtags, per
       * platform) with the language model, in this language and script.
       */
      copy: z
        .strictObject({
          language: z.string().trim().min(2).max(64),
          scriptMode: z.enum(["auto", "roman", "native", "bilingual"]),
        })
        .optional(),
      /**
       * The workspace's jurisdiction (2026-09-29): which language-model
       * providers may read these words. Absent is `in`, the platform default,
       * as for `ai.llm`.
       */
      region: z.enum(["in", "eu", "us"]).optional(),
      /**
       * What its posted clips say worked (2026-10-05, {@link PerformanceSignalSchema}).
       * Absent for a workspace without enough measured posts, and from an API
       * that predates it. A worker from before it refuses a payload that has
       * it (strict), so the worker deploys first.
       */
      performance: PerformanceSignalSchema.optional(),
      /**
       * YouTube native chapters ingested as semantic boundary priors (Pillar 1 §01).
       */
      chapters: z
        .array(
          z.strictObject({
            title: z.string().trim().min(1).max(500),
            startMs: z.int().min(0),
            endMs: z.int().min(0),
          }),
        )
        .max(200)
        .optional(),
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

export const VIRALITY_TIERS = ["VIRAL_GOLD", "HIGH_POTENTIAL", "MODERATE", "STANDARD"] as const;
export const ViralityTierSchema = z.enum(VIRALITY_TIERS);
export type ViralityTier = z.infer<typeof ViralityTierSchema>;

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
    tier: ViralityTierSchema.optional(),
    scoreBreakdown: z.strictObject({
      hook: z.int().min(0).max(100),
      clarity: z.int().min(0).max(100),
      emotion: z.int().min(0).max(100),
      visualActivity: z.int().min(0).max(100),
      novelty: z.int().min(0).max(100),
      standaloneValue: z.int().min(0).max(100),
      safety: z.int().min(0).max(100),
      narrative: z.int().min(0).max(100).optional(),
      energy: z.int().min(0).max(100).optional(),
      trend: z.int().min(0).max(100).optional(),
      pacing: z.int().min(0).max(100).optional(),
    }),
    reasons: z
      .array(
        z.strictObject({
          // `track_record` (2026-10-05) only ever comes back for a payload
          // that carried `options.performance`, which only an API that reads
          // it sends: an older API never meets it.
          label: z.enum(CANDIDATE_REASON_LABELS),
          explanation: z.string().trim().min(1).max(240),
        }),
      )
      .min(1)
      .max(12),
    /** The clip's words for posting, when the model wrote them (2026-09-29). */
    copy: ClipCopySchema.optional(),
    /** Explainable AI scoring diagnostic rationale (Pillar 2 §02). */
    diagnostic: ViralityDiagnosticSchema.optional(),
    /**
     * The language model's reading of the moment, 0-10 each: does it stand on
     * its own, does it land its point, is it funny, and (with a topic) is it
     * about what was asked for.
     */
    judgement: z
      .strictObject({
        standalone: z.int().min(0).max(10),
        payoff: z.int().min(0).max(10),
        humour: z.int().min(0).max(10),
        topicFit: z.int().min(0).max(10).optional(),
        /**
         * The clip's analysis as its page shows it (2026-10-01, OpusClip's
         * Hook / Flow / Value / Trend): how hard its first seconds grab, and
         * how much its subject is one people are talking about now. Flow and
         * Value are `standalone` and `payoff`. Optional: a model may leave
         * them out, and moments judged before them have none.
         */
        hook: z.int().min(0).max(10).optional(),
        trend: z.int().min(0).max(10).optional(),
        /** One sentence on each of the four, in the clip's own terms. */
        notes: z
          .strictObject({
            hook: z.string().trim().min(1).max(240).optional(),
            flow: z.string().trim().min(1).max(240).optional(),
            value: z.string().trim().min(1).max(240).optional(),
            trend: z.string().trim().min(1).max(240).optional(),
          })
          .optional(),
        /** People the moment names or features, as said in it ("Relevant people"). */
        people: z.array(z.string().trim().min(1).max(60)).max(5).optional(),
        model: z.string().trim().min(1).max(100),
      })
      .optional(),
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
  proposals: z.array(HighlightProposalSchema).max(40),
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

/**
 * Bounds and profile are in the key: re-cutting after a trim is new work. So
 * is a new layout (2026-10-01): a stacked cut's key ends `:stacked`, and a
 * one-window cut's key is exactly what it always was, so every job already
 * written still reads as the cut it was.
 */
export function mediaClipJobKey(
  candidateId: string,
  boundsFingerprint: string,
  profileVersion: string,
  layout: ClipLayout = "single",
): string {
  return `media.clip:${candidateId}:${boundsFingerprint}:${profileVersion}${layoutKeySuffix(layout)}`;
}

/** The end of a cut's job key that names its layout: nothing for one window. */
export function layoutKeySuffix(layout: ClipLayout): string {
  return layout === "stacked" ? ":stacked" : layout === "fit" ? ":fit" : "";
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
/**
 * `media.stills` (2026-09-29): a clip's image formats, each one frame of one of
 * its videos (derived store) cropped to a size and written as a JPEG. The API
 * picks the frames and the keys; the worker only takes them.
 */
const StillNameSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);
export const StillRequestSchema = z.strictObject({
  name: StillNameSchema,
  sourceKey: StorageKeySchema,
  atMs: z.number().int().nonnegative(),
  width: z.number().int().min(16).max(4096),
  height: z.number().int().min(16).max(4096),
  focusY: z.number().min(0).max(1).optional(),
  destinationKey: StorageKeySchema,
});
export const MediaStillsPayloadSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  runId: UlidSchema,
  clipId: UlidSchema,
  destination: StorageObjectSchema,
  images: z.array(StillRequestSchema).min(1).max(40),
  /** Which videos the images were taken from; echoed in the result. */
  fingerprint: z.string().min(1).max(512),
});
export const MediaStillsResultSchema = z.object({
  schemaVersion: z.literal(1),
  clipId: UlidSchema,
  fingerprint: z.string().min(1).max(512),
  images: z
    .array(
      z.object({
        name: StillNameSchema,
        key: z.string().min(1),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        sizeBytes: z.number().int().nonnegative(),
        atMs: z.number().nonnegative(),
      }),
    )
    .max(40),
});

export const RequestedAspectsSchema = z.array(AspectSchema).min(1).max(4);

export type MediaAcquirePayload = z.infer<typeof MediaAcquirePayloadSchema>;
export type MediaAcquireResult = z.infer<typeof MediaAcquireResultSchema>;
export type MediaClipPayload = z.infer<typeof MediaClipPayloadSchema>;
export type MediaClipResult = z.infer<typeof MediaClipResultSchema>;
export type HighlightsPayload = z.infer<typeof HighlightsPayloadSchema>;
export type HighlightProposal = z.infer<typeof HighlightProposalSchema>;
export type HighlightsResult = z.infer<typeof HighlightsResultSchema>;
export type PerformanceSignal = z.infer<typeof PerformanceSignalSchema>;
export type HookStyle = (typeof HOOK_STYLES)[number];
export type PerformancePlatform = (typeof PERFORMANCE_PLATFORMS)[number];
export type StillRequest = z.infer<typeof StillRequestSchema>;
export type MediaStillsPayload = z.infer<typeof MediaStillsPayloadSchema>;
export type MediaStillsResult = z.infer<typeof MediaStillsResultSchema>;
