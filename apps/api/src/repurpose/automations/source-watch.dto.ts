import { z } from "zod";

import { BULK_MAX_LINKS, MAX_BACKFILL, WATCH_STATE_REASONS } from "./source-watch.constants.js";
import { zodDto } from "../../common/index.js";
import { createRunSchema } from "../repurpose.dto.js";

/**
 * Request and response shapes for channel automations and for starting several
 * runs at once (2026-10-02).
 *
 * A watch keeps EXACTLY the `setup` a start-form run sends - the same schema
 * object, `createRunSchema.shape.setup` - so every rule that applies to a run's
 * setup applies to a watch's, and a later rule does too. On top of it, a watch
 * refuses two things that only make sense for one video with a person at the
 * page: a picked start time, and moments picked by hand.
 */

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const link = z.string().trim().min(1).max(2_048);

/** The start form's setup, unchanged. */
export const runSetupSchema = createRunSchema.shape.setup;

/** A setup every one of a channel's videos can run with, with nobody at the page. */
export const watchSetupSchema = runSetupSchema.superRefine((setup, context) => {
  if (setup.window?.startMs !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["window", "startMs"],
      message:
        "A start time belongs to one video. Each of a channel's videos starts at its own beginning.",
    });
  }
  if (setup.discovery.mode === "manual") {
    context.addIssue({
      code: "custom",
      path: ["discovery", "mode"],
      message:
        "A channel's videos are made into clips while nobody is at the page, so we find the moments.",
    });
  }
  if (setup.automation === "manual") {
    context.addIssue({
      code: "custom",
      path: ["automation"],
      message: "A channel's videos always run on Autopilot.",
    });
  }
  // 2026-10-04 (audiograms): a cover is drawn only for a source with no
  // picture, which a channel's video never is. Refused here rather than kept:
  // a watch starts its runs later, with nobody at the page, and a cover that
  // was never uploaded would refuse every one of them.
  if (setup.audiogram !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["audiogram"],
      message: "A channel's videos have pictures of their own. A cover is for an audio file.",
    });
  }
  // 2026-10-01: a caption file is written for one video, never for a channel's
  // next upload.
  if (setup.captions !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["captions"],
      message:
        "A caption file belongs to one video. A channel's videos are each captioned for you.",
    });
  }
});
export type WatchSetup = z.infer<typeof watchSetupSchema>;

/** `POST /repurpose/watches/resolve`: which channel a link is, for the form's preview. */
export const resolveChannelSchema = z.object({ url: link });
export class ResolveChannelDto extends zodDto(resolveChannelSchema) {}

/** `POST /repurpose/watches`. */
export const createWatchSchema = z.object({
  url: link,
  setup: watchSetupSchema,
  /** "Also make clips of my latest N videos" (0-3), at the first check. */
  backfill: z.number().int().min(0).max(MAX_BACKFILL).default(0),
  /** "I own this channel or have permission to use its videos." */
  rightsAttested: z.literal(true),
});
export class CreateWatchDto extends zodDto(createWatchSchema) {}
export type CreateWatchInput = z.infer<typeof createWatchSchema>;

/** `PATCH /repurpose/watches/{id}`: new settings for the runs it starts from now on. */
export const updateWatchSchema = z.object({ setup: watchSetupSchema });
export class UpdateWatchDto extends zodDto(updateWatchSchema) {}
export type UpdateWatchInput = z.infer<typeof updateWatchSchema>;

export const resolvedChannelSchema = z.object({
  channelId: z.string(),
  title: z.string(),
  handle: z.string().nullable(),
  channelUrl: z.string(),
  /** This workspace's watch of the channel, when it already has one. */
  watchId: ulid.nullable(),
});
export type ResolvedChannelView = z.infer<typeof resolvedChannelSchema>;

export const WATCH_VIDEO_STATES = ["pending", "starting", "started", "skipped", "failed"] as const;

export const watchVideoViewSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  publishedAt: z.string(),
  state: z.enum(WATCH_VIDEO_STATES),
  /** Why it was skipped or failed (`short`, `too_old`, `upcoming`, ...). */
  reason: z.string().nullable(),
  /** One of the latest videos asked for when the watch was made. */
  backfill: z.boolean(),
  runId: ulid.nullable(),
  /** The run's status, while the run exists. */
  runStatus: z.string().nullable(),
});
export type WatchVideoView = z.infer<typeof watchVideoViewSchema>;

export const watchViewSchema = z.object({
  id: ulid,
  kind: z.literal("youtube_channel"),
  channelId: z.string(),
  channelUrl: z.string(),
  title: z.string(),
  handle: z.string().nullable(),
  state: z.enum(["active", "paused", "error"]),
  stateReason: z.enum(WATCH_STATE_REASONS).nullable(),
  /** One sentence for a paused or failed watch; null while it is active. */
  message: z.string().nullable(),
  setup: runSetupSchema,
  backfillCount: z.number().int().min(0).max(MAX_BACKFILL),
  lastCheckedAt: z.string().nullable(),
  /** When it is read next; null while it is not active. */
  nextCheckAt: z.string().nullable(),
  /** The last read's failure (`channel_unreadable`, ...), until a read works. */
  lastErrorCode: z.string().nullable(),
  /** Runs it has started, over its life. */
  runsStarted: z.number().int().min(0),
  /** Its most recent uploads, newest first. */
  videos: z.array(watchVideoViewSchema),
  createdBy: ulid,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WatchView = z.infer<typeof watchViewSchema>;

export const watchListSchema = z.object({
  items: z.array(watchViewSchema),
  /**
   * Whether this server reads feeds at all: the `repurpose.source-watch` task is
   * installed here. False, watches are kept but nothing new starts.
   */
  checksEnabled: z.boolean(),
  maxWatches: z.number().int(),
});
export type WatchList = z.infer<typeof watchListSchema>;

// ---------------------------------------------------------------------------
// Several links at once
// ---------------------------------------------------------------------------

/**
 * `POST /repurpose/runs/bulk`: up to twenty links, one run each, with one
 * setup. A picked start belongs to one video, so it is refused here as for a
 * watch; Autopilot and moments picked by hand are the person's choice.
 */
export const bulkRunsSchema = z.object({
  links: z.array(z.string().max(2_048)).min(1).max(BULK_MAX_LINKS),
  setup: runSetupSchema.superRefine((setup, context) => {
    if (setup.window?.startMs !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["window", "startMs"],
        message: "A start time belongs to one video. Start the runs without one.",
      });
    }
    // 2026-10-01: so is a caption file.
    if (setup.captions !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["captions"],
        message: "A caption file belongs to one video. Start the runs without one.",
      });
    }
  }),
  rightsAttested: z.literal(true),
});
export class BulkRunsDto extends zodDto(bulkRunsSchema) {}
export type BulkRunsInput = z.infer<typeof bulkRunsSchema>;

export const BULK_OUTCOMES = ["started", "already_running", "duplicate", "refused"] as const;

export const bulkRunResultSchema = z.object({
  /** The link's position in the request, from 0. */
  index: z.number().int().min(0),
  link: z.string(),
  outcome: z.enum(BULK_OUTCOMES),
  /** The run started, or the one already running for this video. */
  runId: ulid.nullable(),
  /** Why it was refused: the same codes a single start answers with. */
  code: z.string().nullable(),
  message: z.string().nullable(),
});
export type BulkRunResult = z.infer<typeof bulkRunResultSchema>;

export const bulkRunsResponseSchema = z.object({
  results: z.array(bulkRunResultSchema),
  started: z.number().int().min(0),
});
export type BulkRunsResponse = z.infer<typeof bulkRunsResponseSchema>;
