import { z } from "zod";

import { ClipLengthPresetSchema } from "@montaj/repurpose-contracts";

import {
  AUTOMATION_MODES,
  DEFAULT_MAX_CANDIDATE_MS,
  DEFAULT_MIN_CANDIDATE_MS,
  DEFAULT_REQUESTED_CANDIDATES,
  RUN_PAGE_MAX,
  RUN_PAGE_SIZE,
  WINDOW_POLICIES,
  WINDOW_START_MAX_MS,
} from "./repurpose.constants.js";
import { STAGES } from "./repurpose.projection.js";
import { ACTIVITY_STEPS } from "./run-activity.js";
import { RUN_CAPTION_KINDS } from "./run-captions.js";
import { MAX_SKIP_MS } from "./steering.js";
import { zodDto } from "../common/index.js";
import { IMPORT_MAX_BYTES } from "../projects/projects.constants.js";

/**
 * Request and response shapes for `/repurpose/runs` (REP-006).
 *
 * These mirror `@montaj/repurpose-contracts` rather than importing it into the
 * Nest DTO layer, for the same reason every other module keeps its own DTOs: the
 * contract package is the cross-runtime shape, and the DTO is what this HTTP
 * surface accepts, including the Swagger metadata `zodDto` attaches.
 * `repurpose.dto.test.ts` asserts the two agree, so a drift is a test failure.
 */

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const language = z.string().trim().min(2).max(64);
const shortLabel = z.string().trim().min(1).max(160);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const captionSetupSchema = z.object({
  /** `"same"` keeps the spoken language; anything else is a target language. */
  outputLanguage: z.union([z.literal("same"), language]).default("same"),
  /** Roman Hindi is `roman` + `hi-Latn`, never flattened to English (§10.4). */
  scriptMode: z.enum(["auto", "roman", "native", "bilingual"]).default("auto"),
  styleId: shortLabel,
});

export const discoverySetupSchema = z
  .object({
    mode: z.enum(["ai", "manual", "mixed"]).default("ai"),
    requestedCandidates: z.number().int().min(0).max(20).default(DEFAULT_REQUESTED_CANDIDATES),
    minDurationMs: z.number().int().min(3_000).max(180_000).default(DEFAULT_MIN_CANDIDATE_MS),
    maxDurationMs: z.number().int().min(3_000).max(180_000).default(DEFAULT_MAX_CANDIDATE_MS),
    contentGoal: z.enum(["reach", "education", "authority", "engagement"]).default("reach"),
    /**
     * Steering (2026-09-29), as `CreateRunRequestSchema.setup.discovery` has it:
     * what the clips should be about, how long they should be (a preset, which
     * wins over the two bounds above), and how much of the video's start and
     * end to take no clip from. All optional; absent is the run as before.
     */
    topic: z.string().trim().min(2).max(200).optional(),
    clipLength: ClipLengthPresetSchema.optional(),
    skipIntroMs: z.number().int().min(0).max(MAX_SKIP_MS).optional(),
    skipOutroMs: z.number().int().min(0).max(MAX_SKIP_MS).optional(),
  })
  .superRefine((value, context) => {
    if (value.minDurationMs > value.maxDurationMs) {
      context.addIssue({
        code: "custom",
        path: ["maxDurationMs"],
        message: "The longest clip cannot be shorter than the shortest.",
      });
    }
    if (value.mode === "manual" && value.requestedCandidates !== 0) {
      context.addIssue({
        code: "custom",
        path: ["requestedCandidates"],
        message: "Manual mode does not ask for AI suggestions.",
      });
    }
  });

/**
 * The source, as a discriminated union.
 *
 * `rightsAttested` is `true` and nothing else for an external link: a checkbox
 * the user must actively tick, recorded with a timestamp (§9.3). It is an
 * attestation, not proof — it makes the claim auditable, it does not verify it.
 */
export const createRunSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("url"),
    url: z.string().trim().min(1).max(2_048),
    rightsAttested: z.literal(true),
  }),
  z.object({
    kind: z.literal("upload"),
    filename: shortLabel,
    mime: z.string().trim().min(3).max(100),
    sizeBytes: z.number().int().positive().max(10_000_000_000),
    /** Client-computed hash, so a re-upload of the same file is deduplicated. */
    contentHash: sha256.optional(),
    /**
     * Whether to issue the multipart ticket with the run.
     *
     * Default true, which is what an API client wants: one call returns the run
     * and somewhere to PUT the bytes. The web app passes FALSE, because it hands
     * the file to the existing upload queue instead, and that queue calls
     * `POST /projects/{id}/media/init` itself — asking for a ticket we would then
     * ignore leaves an orphan `pending` media row behind every upload.
     */
    issueUploadTicket: z.boolean().default(true),
  }),
]);

/**
 * Which part of a long link to process (2026-09-27). Optional: without it the
 * run takes YouTube's most-replayed stretch when there is one, else the start.
 * A `startMs` is a start the person picked, which is what `range` means - so a
 * start with another policy, or `range` without a start, is a contradiction and
 * refused rather than guessed at. The length is never the caller's: it is the
 * plan's window, cut to what the balance pays for.
 */
export const windowSetupSchema = z
  .object({
    startMs: z.number().int().min(0).max(WINDOW_START_MAX_MS).optional(),
    policy: z.enum(WINDOW_POLICIES).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.startMs !== undefined && value.policy !== undefined && value.policy !== "range") {
      context.addIssue({
        code: "custom",
        path: ["policy"],
        message: "A start time means the part you picked; leave the policy out or say range.",
      });
    }
    if (value.policy === "range" && value.startMs === undefined) {
      context.addIssue({
        code: "custom",
        path: ["startMs"],
        message: "Say where the part you picked starts.",
      });
    }
  });

/**
 * Captions the person already has for the video (2026-10-01, OpusClip's
 * "upload SRT"): an SRT or WebVTT file picked on the form and sent as its text,
 * or a link to one. The run then aligns them to the audio instead of paying
 * for a transcription (`repurpose/run-captions.ts`). At most 2 MB, as the
 * editor's subtitle import; whether the text really is SRT or VTT is the
 * parser's call, at create, before anything is written.
 */
export const runCaptionsSetupSchema = z.discriminatedUnion("from", [
  z
    .object({
      from: z.literal("file"),
      kind: z.enum(RUN_CAPTION_KINDS),
      content: z.string().min(1).max(IMPORT_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      from: z.literal("url"),
      url: z
        .string()
        .trim()
        .min(1)
        .max(2_048)
        .regex(/^https?:\/\//i, "A link to a caption file starts with https://."),
      /** Left out, the link's own extension says (`.srt`, `.vtt`). */
      kind: z.enum(RUN_CAPTION_KINDS).optional(),
    })
    .strict(),
]);

export const createRunSchema = z.object({
  source: createRunSourceSchema,
  setup: z.object({
    /**
     * A BCP-47 tag, or `"auto"`: the clips default (2026-09-27), which lets the
     * transcription detect the language instead of trusting a remembered pick.
     */
    sourceLanguage: z.union([z.literal("auto"), language]),
    caption: captionSetupSchema,
    discovery: discoverySetupSchema,
    window: windowSetupSchema.optional(),
    /**
     * Autopilot (2026-09-28): `auto` cuts every suggested moment into a clip
     * and retries what fails for a passing reason, with nobody at the page;
     * `manual` (the default) waits for the person to pick the moments.
     */
    automation: z.enum(AUTOMATION_MODES).optional(),
    /**
     * The brand kit (2026-10-02): Autopilot gives the clips the workspace's
     * logo, end card, caption and title colours and typefaces. Left out, or
     * with no kit saved, the clips are made exactly as without one.
     */
    brand: z.boolean().optional(),
    /**
     * B-roll (2026-10-05): Autopilot cuts away to a picture where the speaker
     * names something visual - from the workspace's B-roll library first, a
     * stock photo second when stock photos are set up. Left out, or with
     * nothing to show, the clips are made exactly as without it.
     */
    broll: z.boolean().optional(),
    /**
     * Audiograms (2026-10-04): the cover a source with no picture - an audio
     * file - has its clips drawn with, uploaded first through
     * `POST /repurpose/covers`. Left out, the brand kit's logo (with `brand`)
     * or nothing is the artwork; a source with a picture never uses it.
     */
    audiogram: z.object({ coverAssetId: ulid }).strict().optional(),
    /**
     * Captions for the video the person already has (2026-10-01): aligned to
     * the audio instead of transcribed, so finding the moments costs no
     * credits. One video's own file, so never part of a saved default or a
     * channel automation's setup.
     */
    captions: runCaptionsSetupSchema.optional(),
  }),
  /** Optional title; defaults to the source's safe display form. */
  title: shortLabel.optional(),
});
export class CreateRunDto extends zodDto(createRunSchema) {}

export const listRunsSchema = z.object({
  cursor: ulid.optional(),
  limit: z.coerce.number().int().min(1).max(RUN_PAGE_MAX).default(RUN_PAGE_SIZE),
  status: z
    .enum([
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
    ])
    .optional(),
});
export class ListRunsDto extends zodDto(listRunsSchema) {}

const stageViewSchema = z.object({
  stage: z.enum(STAGES),
  state: z.enum(["waiting", "running", "complete", "failed"]),
  label: z.string(),
});

/** `RunActivity` (`run-activity.ts`): the step under way and how far it is. */
export const runActivitySchema = z.object({
  step: z.enum(ACTIVITY_STEPS),
  label: z.string(),
  percent: z.number().int().min(0).max(100).optional(),
  detail: z.string().optional(),
  etaSeconds: z.number().int().min(0).optional(),
  queuePosition: z.number().int().min(0).optional(),
});

/** What every run-shaped response returns. No job id, no queue name (§13.4). */
export const runViewSchema = z.object({
  id: ulid,
  workspaceId: ulid,
  sourceProjectId: ulid,
  sourceKind: z.enum(["upload", "youtube_url", "direct_media_url"]),
  sourceDisplay: z.string().nullable(),
  mode: z.enum(["ai", "manual", "mixed"]),
  status: z.string(),
  currentStage: z.enum(STAGES),
  progress: z.number().int().min(0).max(100),
  stages: z.array(stageViewSchema),
  message: z.string(),
  failureCode: z.string().nullable(),
  canCancel: z.boolean(),
  canRetry: z.boolean(),
  candidateCount: z.number().int().min(0),
  clipCount: z.number().int().min(0),
  variantCount: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The video's real title, once the download reported it. */
  sourceTitle: z.string().nullable(),
  /**
   * The part of the source this run processed, in the source's own clock; null
   * until the section landed, and for a source processed whole.
   */
  window: z
    .object({
      startMs: z.number().int().min(0),
      endMs: z.number().int().min(0),
      sourceDurationMs: z.number().int().min(0),
      policy: z.enum(WINDOW_POLICIES),
    })
    .nullable(),
  /** The numbers behind `failureCode`, while the run is failed; null otherwise. */
  failureDetail: z
    .object({
      durationMs: z.number().optional(),
      maxDurationMs: z.number().optional(),
      maxBytes: z.number().optional(),
      approximateBytes: z.number().optional(),
      windowMs: z.number().optional(),
      creditsLeft: z.number().optional(),
    })
    .nullable(),
  /** `POST .../next-window` has something after this window to process. */
  nextWindowAvailable: z.boolean(),
  /** Autopilot (`auto`) or the person picks the moments (`manual`); see `setup.automation`. */
  automation: z.enum(AUTOMATION_MODES),
  /**
   * Whether the run asked for the brand kit (`setup.brand`, 2026-10-02).
   * Optional only so a view described before it still reads as one.
   */
  brand: z.boolean().optional(),
  /** Whether the run asked for B-roll (`setup.broll`, 2026-10-05); optional for the same reason. */
  broll: z.boolean().optional(),
  /**
   * Whether Autopilot puts its hook title on this run's clips (2026-10-01):
   * on unless the run page's switch turned it off. Optional for the same
   * reason; only meaningful with `automation: "auto"`.
   */
  hookTitles: z.boolean().optional(),
  /**
   * Why a run that is not failed is not moving, and until when: YouTube is
   * refusing this server's downloads, and the run continues by itself after
   * `until` (`SourceGate`). Null when nothing is holding it.
   */
  waitingFor: z
    .object({
      reason: z.literal("source_busy"),
      until: z.string(),
    })
    .nullable(),
  /**
   * What the run was steered with at the start (2026-09-29), for "About: money
   * habits · Short clips": null when it was not. Always sent; optional here
   * only so a view described before it still reads as one.
   */
  steering: z
    .object({
      topic: z.string().nullable(),
      clipLength: ClipLengthPresetSchema.nullable(),
      skipIntroMs: z.number().int().min(0),
      skipOutroMs: z.number().int().min(0),
    })
    .nullable()
    .optional(),
  /**
   * What the run is doing this moment, as one step with its own progress
   * (2026-09-29, `run-activity.ts`): "Downloading your video · 3.1 of 5.0 GB ·
   * about 2 min left". Null for a run that has stopped or is past its clips.
   * Optional only so a view built before it existed still parses.
   */
  activity: runActivitySchema.nullable().optional(),
});

/** `POST /repurpose/runs/{id}/next-window`: the new run over the next part of the source. */
export const nextWindowResponseSchema = z.object({ run: runViewSchema });

export const runPageSchema = z.object({
  items: z.array(runViewSchema),
  nextCursor: z.string().nullable(),
});

/** The upload ticket, re-exported unchanged from the existing media contract. */
const uploadTicketSchema = z.object({
  mediaId: ulid,
  uploadId: z.string().nullable(),
  key: z.string(),
  bucket: z.enum(["s3", "r2"]),
  partSizeBytes: z.number().int(),
  parts: z.array(z.object({ partNumber: z.number().int(), url: z.string() })),
  expiresAt: z.string().nullable(),
  duplicate: z.boolean(),
});

export const createRunResponseSchema = z.object({
  run: runViewSchema,
  projectId: ulid,
  /** Present only for an upload; a link run has nothing for the browser to PUT. */
  upload: uploadTicketSchema.nullable(),
  next: z.object({ rel: z.literal("run"), href: z.string() }),
});

export type CreateRunInput = z.infer<typeof createRunSchema>;
export type ListRunsInput = z.infer<typeof listRunsSchema>;
export type RunView = z.infer<typeof runViewSchema>;
export type RunPage = z.infer<typeof runPageSchema>;
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;
export type NextWindowResponse = z.infer<typeof nextWindowResponseSchema>;
export type WindowSetup = z.infer<typeof windowSetupSchema>;
export type RunCaptionsSetup = z.infer<typeof runCaptionsSetupSchema>;
