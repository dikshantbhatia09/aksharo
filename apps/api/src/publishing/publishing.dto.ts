import { z } from "zod";

import { zodDto } from "../common/index.js";

import type { SupportedProvider, VideoShape } from "./platforms.js";
import type { $Enums } from "@prisma/client";

/**
 * Request bodies and answers for posting clips (2026-09-29).
 *
 * Bodies are strict about shape and loose about meaning: a time in the past,
 * a text too long for X, a channel that went away are refused by the service
 * with a `publishing/*` code and a sentence, not by a Zod issue list.
 */

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

const textSchema = z.object({
  title: z.string().max(500).optional(),
  body: z.string().max(10_000),
});

/** The person's edited text, per platform; a platform left out gets the default. */
const textsSchema = z.object({
  instagram: textSchema.optional(),
  facebook: textSchema.optional(),
  youtube: textSchema.optional(),
  tiktok: textSchema.optional(),
  linkedin: textSchema.optional(),
  x: textSchema.optional(),
  threads: textSchema.optional(),
});

/** Who sees the post, where the platform asks. Defaults: YouTube public, TikTok only me. */
const visibilitySchema = z.object({
  youtube: z.enum(["public", "unlisted", "private"]).optional(),
  tiktok: z.enum(["public", "friends", "private"]).optional(),
});

const clockSchema = z.string().regex(/^\d{2}:\d{2}$/);
const zoneSchema = z.string().trim().min(1).max(64);

export const whenSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("now") }),
  /** An instant with its offset (`2026-10-02T19:00:00+05:30`), and the zone it was picked in. */
  z.object({
    kind: z.literal("at"),
    at: z.iso.datetime({ offset: true }),
    timezone: zoneSchema.optional(),
  }),
  /** The next free day at `time` (default 19:00) in `timezone` (default India). */
  z.object({
    kind: z.literal("daily"),
    time: clockSchema.optional(),
    timezone: zoneSchema.optional(),
  }),
]);
export type When = z.infer<typeof whenSchema>;

/** `POST /repurpose/runs/{runId}/clips/{clipId}/posts`. */
export const publishClipSchema = z.object({
  channelIds: z.array(ulid).min(1).max(20),
  texts: textsSchema.optional(),
  visibility: visibilitySchema.optional(),
  when: whenSchema,
  /** Post again to an account this clip already went to (a new post, deliberately). */
  again: z.boolean().optional(),
});
export class PublishClipDto extends zodDto(publishClipSchema) {}
export type PublishClipInput = z.infer<typeof publishClipSchema>;

/** `POST /repurpose/runs/{runId}/posts/daily`: "Post one a day". */
export const dailyPostsSchema = z.object({
  clipIds: z.array(ulid).min(1).max(40),
  channelIds: z.array(ulid).min(1).max(20),
  time: clockSchema.optional(),
  timezone: zoneSchema.optional(),
  /** First day to use (`YYYY-MM-DD` in `timezone`); today or tomorrow by default. */
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  visibility: visibilitySchema.optional(),
});
export class DailyPostsDto extends zodDto(dailyPostsSchema) {}
export type DailyPostsInput = z.infer<typeof dailyPostsSchema>;

export type Visibility = z.infer<typeof visibilitySchema>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Why posting is not available, when it is not. */
export type UnavailableReason =
  | "flag_off"
  | "not_this_workspace"
  | "not_configured"
  | "unreachable"
  | "key_refused"
  | "no_channels";

export interface PublishingStatusView {
  /** The feature is switched on for this workspace: the page offers posting at all. */
  readonly enabled: boolean;
  /** Posting would work right now. */
  readonly available: boolean;
  readonly reason: UnavailableReason | null;
  /** One sentence saying what is missing, or null. */
  readonly message: string | null;
  /** Where to open Postiz, for a workspace allowed to use it; null otherwise. */
  readonly postizUrl: string | null;
  /** Connected channels Aksharo can post to. */
  readonly channelCount: number;
}

export interface ChannelView {
  /** Our `channel_connections` id; null for a channel Aksharo does not post to. */
  readonly id: string | null;
  readonly provider: SupportedProvider | null;
  /** "Instagram", or Postiz's own name for an unsupported one. */
  readonly platform: string;
  readonly name: string;
  readonly username: string | null;
  readonly avatarUrl: string | null;
  readonly supported: boolean;
  readonly disabled: boolean;
  /** One sentence when it cannot be picked (disabled, TikTok not switched on, not supported). */
  readonly note: string | null;
}

export interface PlanChannelView extends ChannelView {
  /** "Reel", "Short", "Feed video", "Video". */
  readonly surface: string;
  readonly shape: VideoShape | null;
  /** It can be picked for this clip now. */
  readonly ready: boolean;
}

export interface PlanTextView {
  readonly title: string | null;
  readonly body: string;
  readonly bodyLimit: number;
  readonly titleLimit: number | null;
  readonly titleRequired: boolean;
  /** X counts links as 23 characters; null elsewhere. */
  readonly linkLength: number | null;
}

export interface PublishPlanView {
  readonly status: PublishingStatusView;
  readonly clip: {
    readonly id: string;
    readonly title: string;
    readonly durationMs: number | null;
  };
  readonly channels: readonly PlanChannelView[];
  readonly texts: Partial<Record<SupportedProvider, PlanTextView>>;
  readonly visibility: { readonly youtube: "public"; readonly tiktok: "private" };
  readonly defaults: { readonly timezone: string; readonly dailyTime: string };
  /** For "One a day": each channel's next free slot at the default time. */
  readonly nextDaily: Readonly<Record<string, string>>;
  /**
   * Clip review (2026-10-03): whether the workspace needs approval before
   * posting, whether this clip has it, and why not in one sentence. While it
   * does not, every channel reads not ready with that sentence as its note.
   */
  readonly approval: {
    readonly required: boolean;
    readonly approved: boolean;
    readonly message: string | null;
  };
}

/** A post as the page shows it. `status` is the plain version of `state`. */
export type PostStatus = "posting" | "scheduled" | "posted" | "failed" | "cancelled";

export interface PostView {
  readonly id: string;
  readonly clipId: string;
  readonly runId: string;
  readonly channel: {
    readonly id: string;
    readonly name: string;
    readonly avatarUrl: string | null;
  } | null;
  readonly provider: string;
  readonly platform: string;
  readonly shape: VideoShape | null;
  readonly status: PostStatus;
  readonly state: $Enums.PublishTargetStatus;
  readonly scheduledAt: string | null;
  readonly publishedAt: string | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly text: string;
  readonly error: { readonly code: string; readonly message: string } | null;
  /** A line about a post that has not failed: waiting for a slot, deleted where it was scheduled. */
  readonly note: string | null;
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  readonly createdAt: string;
}

export interface PublishResultView {
  readonly batchId: string;
  readonly posts: readonly PostView[];
}
