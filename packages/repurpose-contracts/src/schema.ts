import { z } from "zod";

/** Contracts are provisional until CP-020 review; never infer a version from a payload. */
export const REPURPOSE_SCHEMA_VERSION = 1 as const;
export const REPURPOSE_CONFIG_VERSION = 1 as const;

export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const MillisecondsSchema = z.int().nonnegative();

export const SOURCE_KINDS = ["upload", "youtube_url", "direct_media_url"] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export const RUN_MODES = ["ai", "manual", "mixed"] as const;
export const RunModeSchema = z.enum(RUN_MODES);
export const RUN_STATUSES = [
  "draft",
  "acquiring",
  "preparing_media",
  "transcribing",
  "analyzing",
  "candidates_ready",
  "materializing",
  "rendering",
  "review_ready",
  "changes_requested",
  "approved",
  "publishing",
  "partially_published",
  "published",
  "failed",
  "cancelled",
] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export const CANDIDATE_SOURCES = ["ai", "manual"] as const;
export const CandidateSourceSchema = z.enum(CANDIDATE_SOURCES);
export const CANDIDATE_STATES = ["proposed", "selected", "rejected", "materialized"] as const;
export const CandidateStateSchema = z.enum(CANDIDATE_STATES);
export const VARIANT_STATUSES = ["preparing", "rendering", "ready", "stale", "failed"] as const;
export const VariantStatusSchema = z.enum(VARIANT_STATUSES);
export const ASPECTS = ["9:16", "4:5", "1:1", "16:9"] as const;
export const AspectSchema = z.enum(ASPECTS);

export const STAGES = [
  "getting_video",
  "finding_clips",
  "styles_formats",
  "review",
  "publish",
] as const;
export const StageSchema = z.enum(STAGES);

const LanguageSchema = z.string().trim().min(2).max(64);
const ShortLabelSchema = z.string().trim().min(1).max(160);
const ScoreSchema = z.int().min(0).max(100);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const CaptionConfigSchema = z.strictObject({
  outputLanguage: z.union([z.literal("same"), LanguageSchema]),
  scriptMode: z.enum(["auto", "roman", "native", "bilingual"]),
  styleId: ShortLabelSchema,
  styleVersion: z.int().positive(),
});

export const DiscoveryConfigSchema = z
  .strictObject({
    mode: RunModeSchema,
    requestedCandidates: z.int().min(0).max(20),
    minDurationMs: z.int().min(3_000).max(180_000),
    maxDurationMs: z.int().min(3_000).max(180_000),
    contentGoal: z.enum(["reach", "education", "authority", "engagement"]),
  })
  .superRefine((value, context) => {
    if (value.minDurationMs > value.maxDurationMs) {
      context.addIssue({
        code: "custom",
        path: ["maxDurationMs"],
        message: "Maximum duration is below minimum.",
      });
    }
    if (value.mode === "manual" && value.requestedCandidates !== 0) {
      context.addIssue({
        code: "custom",
        path: ["requestedCandidates"],
        message: "Manual mode cannot request AI candidates.",
      });
    }
  });

export const FormatFamilySchema = z.strictObject({
  aspect: AspectSchema,
  destinations: z.array(ShortLabelSchema).max(12),
  reframe: z.enum(["auto", "center", "speaker"]),
});

export const RunConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_CONFIG_VERSION),
    sourceLanguage: LanguageSchema,
    caption: CaptionConfigSchema,
    discovery: DiscoveryConfigSchema,
    formats: z.array(FormatFamilySchema).min(1).max(4),
    enhancements: z.strictObject({
      audioClean: z.boolean(),
      autoZoom: z.boolean(),
      autoTextFx: z.boolean(),
      music: z.enum(["off", "recommended"]),
    }),
  })
  .superRefine((value, context) => {
    const aspects = value.formats.map((format) => format.aspect);
    if (new Set(aspects).size !== aspects.length) {
      context.addIssue({
        code: "custom",
        path: ["formats"],
        message: "Each aspect family must appear once.",
      });
    }
  });

export const RunViewSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  id: UlidSchema,
  workspaceId: UlidSchema,
  sourceProjectId: UlidSchema,
  sourceKind: SourceKindSchema,
  mode: RunModeSchema,
  status: RunStatusSchema,
  currentStage: StageSchema,
  progress: ScoreSchema,
  configVersion: z.literal(REPURPOSE_CONFIG_VERSION),
  config: RunConfigSchema,
  failureCode: z.string().max(100).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const SCORE_DIMENSIONS = [
  "hook",
  "clarity",
  "emotion",
  "visualActivity",
  "novelty",
  "standaloneValue",
  "safety",
] as const;
export const CandidateScoreBreakdownSchema = z.strictObject({
  hook: ScoreSchema,
  clarity: ScoreSchema,
  emotion: ScoreSchema,
  visualActivity: ScoreSchema,
  novelty: ScoreSchema,
  standaloneValue: ScoreSchema,
  safety: ScoreSchema,
});

export const CandidateReasonSchema = z.strictObject({
  label: z.enum(["hook", "clear_point", "emotion", "visual", "novelty", "standalone", "safety"]),
  explanation: z.string().trim().min(1).max(240),
});

/** Auditable aggregate features only; never face identity, raw audio, or inferred traits. */
export const CandidateSignalsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  speechActivityPct: ScoreSchema.nullable(),
  visualActivityPct: ScoreSchema.nullable(),
  shotChanges: z.int().nonnegative().max(10_000).nullable(),
});

export const ClipCandidateSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
    id: UlidSchema,
    runId: UlidSchema,
    source: CandidateSourceSchema,
    state: CandidateStateSchema,
    rank: z.int().positive().nullable(),
    startMs: MillisecondsSchema,
    endMs: z.int().positive(),
    startWordId: z.string().max(100).nullable(),
    endWordId: z.string().max(100).nullable(),
    title: ShortLabelSchema,
    transcriptExcerpt: z.string().max(2_000),
    potentialScore: ScoreSchema.nullable(),
    scoreBreakdown: CandidateScoreBreakdownSchema.nullable(),
    reasons: z.array(CandidateReasonSchema).max(12),
    signalVersion: z.int().positive(),
    signals: CandidateSignalsSchema.nullable(),
    promptVersion: z.string().max(100).nullable(),
    model: z.string().max(100).nullable(),
    featureVersion: z.string().max(100).nullable(),
  })
  .superRefine((value, context) => {
    if (value.endMs <= value.startMs) {
      context.addIssue({
        code: "custom",
        path: ["endMs"],
        message: "Candidate end must follow start.",
      });
    }
    if (value.endMs - value.startMs > 180_000) {
      context.addIssue({
        code: "custom",
        path: ["endMs"],
        message: "Candidate exceeds the hard duration limit.",
      });
    }
    if (value.endMs - value.startMs < 3_000) {
      context.addIssue({
        code: "custom",
        path: ["endMs"],
        message: "Candidate is below the hard duration limit.",
      });
    }
    if (value.source === "ai" && (value.rank === null || value.scoreBreakdown === null)) {
      context.addIssue({
        code: "custom",
        path: ["rank"],
        message: "AI candidates need rank and score evidence.",
      });
    }
  });

export const ManualCandidateRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
    startMs: MillisecondsSchema,
    endMs: z.int().positive(),
    snapToWords: z.boolean(),
    title: ShortLabelSchema.optional(),
  })
  .superRefine((value, context) => {
    const duration = value.endMs - value.startMs;
    if (duration < 3_000 || duration > 180_000) {
      context.addIssue({
        code: "custom",
        path: ["endMs"],
        message: "Manual clip duration must be 3–180 seconds.",
      });
    }
  });

export const CandidateListResponseSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  runId: UlidSchema,
  candidates: z.array(ClipCandidateSchema).max(100),
});

export const ClipCopySchema = z.strictObject({
  summary: z.string().trim().max(2_000),
  hook: z.string().trim().max(500),
  cta: z.string().trim().max(500),
  hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]+$/u)).max(30),
  locale: LanguageSchema,
});

export const RepurposeClipViewSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
    id: UlidSchema,
    runId: UlidSchema,
    candidateId: UlidSchema,
    title: ShortLabelSchema,
    sourceStartMs: MillisecondsSchema,
    sourceEndMs: z.int().positive(),
    copyVersion: z.int().positive(),
    copy: ClipCopySchema,
  })
  .superRefine((value, context) => {
    if (value.sourceEndMs <= value.sourceStartMs) {
      context.addIssue({
        code: "custom",
        path: ["sourceEndMs"],
        message: "Clip end must follow start.",
      });
    }
  });

export const ClipVariantViewSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
    runId: UlidSchema,
    clipId: UlidSchema,
    variantId: UlidSchema,
    projectId: UlidSchema,
    aspect: AspectSchema,
    status: VariantStatusSchema,
    editorHref: z.string().startsWith("/p/").max(300),
    editFingerprint: Sha256Schema,
    latestExportId: UlidSchema.nullable(),
    approvedAt: z.iso.datetime().nullable(),
  })
  .superRefine((value, context) => {
    const link = new URL(value.editorHref, "https://aksharo.invalid");
    if (
      link.origin !== "https://aksharo.invalid" ||
      link.pathname !== `/p/${value.projectId}` ||
      link.searchParams.get("returnTo") !== `/repurpose/${value.runId}` ||
      link.searchParams.get("variant") !== value.variantId ||
      [...link.searchParams.keys()].some((key) => key !== "returnTo" && key !== "variant")
    ) {
      context.addIssue({
        code: "custom",
        path: ["editorHref"],
        message: "Editor link does not match this variant.",
      });
    }
  });

export const SAFE_ERROR_CODES = [
  "repurpose/source_invalid_url",
  "repurpose/source_rights_required",
  "repurpose/source_unavailable",
  "repurpose/highlights_failed",
  "repurpose/highlights_no_candidates",
  "repurpose/clip_bounds_invalid",
  "repurpose/variant_stale",
] as const;
export const SafeErrorSchema = z.strictObject({
  code: z.enum(SAFE_ERROR_CODES),
  message: z.string().trim().min(1).max(240),
  retryable: z.boolean(),
});

export const StageProgressSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
    runId: UlidSchema,
    stage: StageSchema,
    state: z.enum(["waiting", "running", "complete", "failed"]),
    percent: ScoreSchema,
    safeError: SafeErrorSchema.nullable(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((value, context) => {
    if ((value.state === "failed") !== (value.safeError !== null)) {
      context.addIssue({
        code: "custom",
        path: ["safeError"],
        message: "Only failed stages carry a safe error.",
      });
    }
  });

const HttpsUrlSchema = z
  .url()
  .refine((url) => url.startsWith("https://"), "Source URL must use HTTPS.");
export const CreateRunSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("youtube_url"),
    url: HttpsUrlSchema,
    rightsAttested: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("direct_media_url"),
    url: HttpsUrlSchema,
    rightsAttested: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("upload"),
    filename: ShortLabelSchema,
    mime: z.string().trim().min(3).max(100),
    sizeBytes: z.int().positive().max(10_000_000_000),
    clientSha256: Sha256Schema.optional(),
    rightsAttested: z.literal(true),
  }),
]);

export const CreateRunRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
    source: CreateRunSourceSchema,
    setup: z.strictObject({
      sourceLanguage: LanguageSchema,
      caption: z.strictObject({
        outputLanguage: z.union([z.literal("same"), LanguageSchema]),
        scriptMode: z.enum(["auto", "roman", "native", "bilingual"]),
        styleId: ShortLabelSchema,
      }),
      discovery: z.strictObject({
        mode: RunModeSchema,
        requestedCandidates: z.int().min(0).max(20),
        contentGoal: z.enum(["reach", "education", "authority", "engagement"]),
      }),
    }),
  })
  .superRefine((value, context) => {
    if (
      value.setup.discovery.mode === "manual" &&
      value.setup.discovery.requestedCandidates !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["setup", "discovery", "requestedCandidates"],
        message: "Manual mode cannot request AI candidates.",
      });
    }
  });

/** Provisional mirror of the existing media upload ticket; parity review is required before route integration. */
export const ExistingMediaViewSchema = z.strictObject({
  id: UlidSchema,
  projectId: UlidSchema,
  role: z.string().min(1),
  bucket: z.enum(["s3", "r2"]),
  storageKey: z.string().min(1),
  filename: z.string().nullable(),
  mime: z.string().nullable(),
  sizeBytes: z.int().nonnegative().nullable(),
  contentHash: Sha256Schema.nullable(),
  durationMs: MillisecondsSchema.nullable(),
  fps: z.number().nonnegative().nullable(),
  width: z.int().nonnegative().nullable(),
  height: z.int().nonnegative().nullable(),
  audioChannels: z.int().nonnegative().nullable(),
  status: z.string().min(1),
  needsRealign: z.boolean(),
  uploadedAt: z.iso.datetime().nullable(),
  rawPurgeAt: z.iso.datetime().nullable(),
  derivedPurgeAt: z.iso.datetime().nullable(),
  derived: z.strictObject({
    proxy: z.string().nullable(),
    audio16k: z.string().nullable(),
    audio48k: z.string().nullable(),
    waveform: z.string().nullable(),
    thumbs: z.array(z.string()),
  }),
  createdAt: z.iso.datetime(),
});

export const ExistingUploadTicketSchema = z.strictObject({
  mediaId: UlidSchema,
  uploadId: z.string().nullable(),
  key: z.string().min(1),
  bucket: z.enum(["s3", "r2"]),
  partSizeBytes: z.int().nonnegative(),
  parts: z.array(z.strictObject({ partNumber: z.int().positive(), url: z.url() })),
  expiresAt: z.iso.datetime().nullable(),
  duplicate: z.boolean(),
  media: ExistingMediaViewSchema,
});

export const CreateRunResponseSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  run: z.strictObject({ id: UlidSchema, status: RunStatusSchema, currentStage: StageSchema }),
  projectId: UlidSchema,
  upload: z.union([z.null(), ExistingUploadTicketSchema]),
  next: z.strictObject({ rel: z.literal("run"), href: z.string().startsWith("/repurpose/") }),
});

export type RunConfig = z.infer<typeof RunConfigSchema>;
export type RunView = z.infer<typeof RunViewSchema>;
export type ClipCandidate = z.infer<typeof ClipCandidateSchema>;
export type RepurposeClipView = z.infer<typeof RepurposeClipViewSchema>;
export type ClipVariantView = z.infer<typeof ClipVariantViewSchema>;
export type StageProgress = z.infer<typeof StageProgressSchema>;
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;
