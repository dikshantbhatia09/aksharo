import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { refreshBatch } from "./batch-status.js";
import { ChannelDirectory, type DirectoryChannel } from "./channel-directory.js";
import { artifactFingerprint, clipVideos, type ShapeVideo } from "./clip-videos.js";
import {
  DEFAULT_DAILY_TIME,
  DEFAULT_TIME_ZONE,
  dayInZone,
  isTimeZone,
  parseClock,
  planDaily,
  type Clock,
  type DailySlot,
} from "./daily-plan.js";
import {
  chooseShape,
  rulesFor,
  tooLongFor,
  type SupportedProvider,
  type VideoShape,
} from "./platforms.js";
import {
  defaultPostText,
  fullEpisodeUrl,
  hashtagsIn,
  problemWithText,
  type ClipWords,
  type PostText,
} from "./post-text.js";
import { POST_INCLUDE, toPostView } from "./post-view.js";
import { postizAppUrl } from "./postiz/postiz-env.js";
import { PostizClient } from "./postiz/postiz.client.js";
import { isPostizError } from "./postiz/postiz.errors.js";
import { PublishDispatcher } from "./publish-dispatcher.js";
import { PublishQueue } from "./publish-queue.js";
import { PublishingAccess } from "./publishing-access.js";
import {
  DAILY_MIN_LEAD_MS,
  MAX_SCHEDULE_AHEAD_MS,
  MIN_SCHEDULE_LEAD_MS,
  PUBLISHING_ERRORS,
  PUBLISHING_FLAGS,
} from "./publishing.constants.js";
import { PUBLISHING_SCHEMA_VERSION } from "./publishing.contract.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { ClipApprovalGate } from "../repurpose/review/clip-approval.gate.js";
import {
  APPROVAL_MESSAGES,
  NOT_REQUIRED,
  mayPost,
  type ApprovalCheck,
} from "../repurpose/review/review-state.js";

import type { CanonicalSettings } from "./postiz/postiz-format.js";
import type {
  ChannelView,
  DailyPostsInput,
  PlanChannelView,
  PlanTextView,
  PostView,
  PublishClipInput,
  PublishPlanView,
  PublishResultView,
  PublishingStatusView,
  UnavailableReason,
  Visibility,
} from "./publishing.dto.js";
import type { $Enums, Prisma } from "@prisma/client";

/**
 * Posting a run's clips to the accounts connected in Postiz (2026-09-29).
 *
 * The routes' half: what can be posted where, confirming a post (now, at a
 * time, or on the next free day), the posts of a run, and cancelling or
 * retrying one. The sending is `PublishDispatcher`'s, driven by the queue.
 *
 * What it holds to:
 *
 *   * **Nothing is posted without an explicit confirmation.** A post row is
 *     created only by a person pressing Post (or "Post one a day") in the
 *     page, never by Autopilot.
 *   * **A post is frozen when it is confirmed** (master plan §6.8): the exact
 *     captioned video (export and fingerprint), the words, the settings and
 *     the time are copied onto the row. Editing the clip afterwards changes
 *     nothing that was agreed.
 *   * **One live post per clip, account and slot.** The idempotency key is
 *     `(clip, account, minute or "now")`, held by the partial unique index of
 *     `prisma/sql/0008`: a double press is one post, and a second "post now"
 *     of the same clip to the same account is refused unless asked for as
 *     "post again", which is a new key.
 *   * **Only a finished captioned video goes out**, in the shape that account
 *     takes (`platforms.ts`).
 *   * **Tenancy**: everything is looked up by workspace and id together, and
 *     posting needs the flag, the workspace named in `POSTIZ_WORKSPACE_IDS`,
 *     and a key (`publishing-access.ts`).
 *   * **Approval, when the workspace asks for it** (2026-10-03, "Clips need
 *     approval before posting"): a clip is posted only once approved, and
 *     only a video its approval pinned (`repurpose/review`). A shape made or
 *     changed after the approval is not posted; a platform that takes another
 *     shape gets that one, and one that takes none is refused with
 *     `publishing/not_approved`. "One a day" leaves such clips out. A retry
 *     sends only a video the clip is still approved with.
 */

const STATUS_MESSAGES: Readonly<Record<UnavailableReason, string>> = Object.freeze({
  flag_off: "Posting to social accounts is not switched on for this workspace.",
  not_this_workspace: "Posting is set up for another workspace, not this one.",
  not_configured:
    "Posting is not set up yet: connect your accounts in Postiz and give Aksharo its API key.",
  unreachable: "The publishing service is not answering right now. Try again in a minute.",
  key_refused: "The publishing service refused Aksharo's key. Check POSTIZ_API_KEY.",
  no_channels: "No accounts are connected yet. Connect them in Postiz, then come back.",
});

/** Who sees a post when nobody says: YouTube public; TikTok only you, which is all an unaudited TikTok app may do. */
const DEFAULT_VISIBILITY = { youtube: "public", tiktok: "private" } as const;

/** Live states: everything but a cancelled or permanently failed post. */
const DEAD_STATES: readonly $Enums.PublishTargetStatus[] = ["cancelled", "failed_permanent"];

const RUN_CLIP_INCLUDE = {
  run: { select: { id: true, workspaceId: true, sourceFingerprint: true } },
  candidate: { select: { state: true } },
} as const satisfies Prisma.RepurposeClipInclude;

type RunClip = Prisma.RepurposeClipGetPayload<{ include: typeof RUN_CLIP_INCLUDE }>;

type PickedChannel = DirectoryChannel & {
  readonly provider: SupportedProvider;
  readonly connection: NonNullable<DirectoryChannel["connection"]>;
};

interface PlannedPost {
  readonly clip: RunClip;
  readonly channel: PickedChannel;
  readonly video: ShapeVideo & { readonly export: NonNullable<ShapeVideo["export"]> };
  readonly text: PostText;
  readonly settings: CanonicalSettings;
  readonly scheduledAt: Date | null;
  readonly key: string;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

function localeOf(copy: Prisma.JsonValue): string {
  const locale =
    typeof copy === "object" && copy !== null && !Array.isArray(copy)
      ? (copy as Record<string, unknown>)["locale"]
      : undefined;
  return typeof locale === "string" && locale.trim().length >= 2
    ? locale.trim().slice(0, 64)
    : "und";
}

/** Aksharo's settings for one post, from the channel and the person's choices. */
export function canonicalSettings(
  provider: SupportedProvider,
  identifier: string,
  visibility: Visibility | undefined,
): CanonicalSettings {
  switch (provider) {
    case "instagram":
      return { provider, surface: "reel", shareToFeed: true, collaborators: [] };
    case "facebook":
      return { provider, surface: "feed", pageId: null };
    case "threads":
      return { provider, surface: "post" };
    case "youtube":
      return {
        provider,
        surface: "short",
        privacy: visibility?.youtube ?? DEFAULT_VISIBILITY.youtube,
        madeForKids: false,
        categoryId: null,
      };
    case "linkedin":
      return {
        provider,
        surface: identifier === "linkedin-page" ? "organization" : "member",
        organizationUrn: null,
        visibility: "public",
      };
    case "tiktok":
      return {
        provider,
        surface: "video",
        privacy: visibility?.tiktok ?? DEFAULT_VISIBILITY.tiktok,
        disclosesBrandedContent: false,
        allowComment: true,
        allowDuet: false,
        allowStitch: false,
      };
    case "x":
      return { provider, surface: "post", replySettings: "everyone" };
  }
}

/** `(clip, account, minute)` - or `now` - is one post; "post again" is a new key. */
export function idempotencyKeyOf(
  clipId: string,
  connectionId: string,
  scheduledAt: Date | null,
  again: boolean,
): string {
  const slot = scheduledAt === null ? "now" : scheduledAt.toISOString().slice(0, 16);
  return `postiz:${clipId}:${connectionId}:${slot}${again ? `:again:${ulid()}` : ""}`;
}

@Injectable()
export class PublishingService {
  private readonly logger = new Logger(PublishingService.name);

  /** A field so a test can set the clock. */
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PublishingAccess,
    private readonly directory: ChannelDirectory,
    private readonly postiz: PostizClient,
    private readonly queue: PublishQueue,
    private readonly dispatcher: PublishDispatcher,
    private readonly audit: CommonAuditService,
    private readonly approvals: ClipApprovalGate,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Whether this workspace can post, and if not, the one thing missing. Never throws. */
  async status(workspaceId: string): Promise<PublishingStatusView> {
    return (await this.statusWithChannels(workspaceId)).status;
  }

  /** The workspace's channels, for the settings page. 404 while the flag is off. */
  async channels(
    workspaceId: string,
  ): Promise<{ readonly status: PublishingStatusView; readonly channels: ChannelView[] }> {
    await this.requireEnabled(workspaceId, false);
    const { status, channels } = await this.statusWithChannels(workspaceId);
    return { status, channels: channels.map((channel) => channel.view) };
  }

  /** Everything the Post dialog shows for one clip. */
  async plan(workspaceId: string, runId: string, clipId: string): Promise<PublishPlanView> {
    await this.requireEnabled(workspaceId, true);
    const clip = await this.requireClip(workspaceId, runId, clipId, false);
    const [{ status, channels }, check] = await Promise.all([
      this.statusWithChannels(workspaceId),
      this.approvals.forClip(workspaceId, clip.id),
    ]);
    const durationMs = clip.mezzanineDurationMs ?? clip.sourceEndMs - clip.sourceStartMs;
    const view: PublishPlanView = {
      status,
      clip: { id: clip.id, title: clip.title, durationMs },
      channels: [],
      texts: {},
      visibility: DEFAULT_VISIBILITY,
      defaults: { timezone: DEFAULT_TIME_ZONE, dailyTime: DEFAULT_DAILY_TIME },
      nextDaily: {},
      approval: {
        required: check.required,
        approved: check.message === null,
        message: check.message,
      },
    };
    if (!status.available) return view;

    const videos = await clipVideos(this.prisma, clip.id);
    const words = this.wordsOf(clip);
    const planChannels: PlanChannelView[] = [];
    const texts: Partial<Record<SupportedProvider, PlanTextView>> = {};
    for (const channel of channels) {
      if (channel.provider === null) continue;
      const { shape, blocker, info } = this.approvedShapeFor(
        channel.provider,
        videos,
        check,
        durationMs,
      );
      const ready = shape !== null && blocker === null && channel.view.note === null;
      planChannels.push({
        ...channel.view,
        surface: rulesFor(channel.provider).surface,
        shape: shape?.shape ?? null,
        ready,
        note: channel.view.note ?? blocker ?? info,
      });
      if (texts[channel.provider] === undefined) {
        const rules = rulesFor(channel.provider);
        texts[channel.provider] = {
          ...defaultPostText(channel.provider, words),
          bodyLimit: rules.bodyLimit,
          titleLimit: rules.titleLimit,
          titleRequired: rules.titleRequired,
          linkLength: rules.weightedCount ? 23 : null,
        };
      }
    }

    const readyIds = planChannels
      .filter((channel) => channel.ready && channel.id !== null)
      .map((channel) => channel.id as string);
    const clock = parseClock(DEFAULT_DAILY_TIME) as Clock;
    const nextDaily: Record<string, string> = {};
    if (readyIds.length > 0) {
      const used = await this.usedDays(workspaceId, channels, readyIds, DEFAULT_TIME_ZONE);
      for (const slot of planDaily({
        clipIds: [clip.id],
        channelIds: readyIds,
        clock,
        timeZone: DEFAULT_TIME_ZONE,
        now: new Date(this.now()),
        usedDays: used,
        minLeadMs: DAILY_MIN_LEAD_MS,
      })) {
        nextDaily[slot.channelId] = slot.at.toISOString();
      }
    }
    return { ...view, channels: planChannels, texts, nextDaily };
  }

  /** A run's posts, newest first; one clip's with `clipId`. */
  async list(
    workspaceId: string,
    runId: string,
    clipId?: string,
  ): Promise<{ readonly posts: PostView[] }> {
    await this.requireEnabled(workspaceId, false);
    await this.requireRun(workspaceId, runId);
    const rows = await this.prisma.publishTarget.findMany({
      where: {
        workspaceId,
        clip: { runId },
        ...(clipId === undefined || clipId === "" ? {} : { clipId }),
      },
      include: POST_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return { posts: rows.map(toPostView) };
  }

  // -------------------------------------------------------------------------
  // Confirming
  // -------------------------------------------------------------------------

  /** Post one clip to the chosen accounts: now, at a time, or on the next free day. */
  async publish(
    workspaceId: string,
    userId: string,
    runId: string,
    clipId: string,
    input: PublishClipInput,
  ): Promise<PublishResultView> {
    await this.requireEnabled(workspaceId, true);
    await this.requireReady(workspaceId);
    const clip = await this.requireClip(workspaceId, runId, clipId, true);
    // Before anything asks Postiz: a clip that needs approval is refused as such.
    const check = await this.approvals.forClip(workspaceId, clip.id);
    if (check.required && check.message !== null) throw notApproved(check.message);
    const { picked: channels, directory } = await this.pickChannels(workspaceId, input.channelIds);
    const videos = await clipVideos(this.prisma, clip.id);
    const durationMs = clip.mezzanineDurationMs ?? clip.sourceEndMs - clip.sourceStartMs;
    const now = this.now();

    // When, per channel.
    let timezone = DEFAULT_TIME_ZONE;
    let slots: ReadonlyMap<string, Date | null>;
    let mode: $Enums.PublishBatchMode = "now";
    const when = input.when;
    if (when.kind === "now") {
      slots = new Map(channels.map((channel) => [channel.connection.id, null]));
    } else if (when.kind === "at") {
      const at = new Date(when.at);
      if (Number.isNaN(at.getTime()) || at.getTime() < now + MIN_SCHEDULE_LEAD_MS) {
        throw new AppException(
          PUBLISHING_ERRORS.timeInvalid,
          "Pick a time at least two minutes from now.",
          HttpStatus.BAD_REQUEST,
        );
      }
      if (at.getTime() > now + MAX_SCHEDULE_AHEAD_MS) {
        throw new AppException(
          PUBLISHING_ERRORS.timeInvalid,
          "Pick a time within the next year.",
          HttpStatus.BAD_REQUEST,
        );
      }
      timezone = this.zoneOf(when.timezone, "UTC");
      mode = "scheduled";
      slots = new Map(channels.map((channel) => [channel.connection.id, at]));
    } else {
      timezone = this.zoneOf(when.timezone, DEFAULT_TIME_ZONE);
      const clock = this.clockOf(when.time);
      mode = "scheduled";
      const ids = channels.map((channel) => channel.connection.id);
      const used = await this.usedDays(workspaceId, directory, ids, timezone);
      const planned = planDaily({
        clipIds: [clip.id],
        channelIds: ids,
        clock,
        timeZone: timezone,
        now: new Date(now),
        usedDays: used,
        minLeadMs: DAILY_MIN_LEAD_MS,
      });
      slots = new Map(planned.map((slot) => [slot.channelId, slot.at]));
    }

    const words = this.wordsOf(clip);
    const posts: PlannedPost[] = [];
    for (const channel of channels) {
      const provider = channel.provider;
      const { shape, blocker, approval } = this.approvedShapeFor(
        provider,
        videos,
        check,
        durationMs,
      );
      if (approval !== null) throw notApproved(approval, { channelId: channel.connection.id });
      if (shape === null || blocker !== null) {
        throw new AppException(
          PUBLISHING_ERRORS.notReady,
          `${rulesFor(provider).label}: ${blocker ?? "No finished video with captions yet."}`,
          HttpStatus.CONFLICT,
          { channelId: channel.connection.id },
        );
      }
      // eslint-disable-next-line security/detect-object-injection -- `provider` is a closed union, not input
      const edited = input.texts?.[provider];
      const text = this.textFor(provider, edited, words);
      const problem = problemWithText(provider, text);
      if (problem !== null) {
        throw new AppException(PUBLISHING_ERRORS.textInvalid, problem, HttpStatus.BAD_REQUEST, {
          provider,
        });
      }
      const scheduledAt = slots.get(channel.connection.id) ?? null;
      if (when.kind === "daily" && scheduledAt === null) {
        throw new AppException(
          PUBLISHING_ERRORS.timeInvalid,
          "There is no free day in the next year for one of these accounts.",
          HttpStatus.BAD_REQUEST,
        );
      }
      posts.push({
        clip,
        channel,
        video: shape,
        text,
        settings: canonicalSettings(provider, channel.integration.identifier, input.visibility),
        scheduledAt,
        key: idempotencyKeyOf(clip.id, channel.connection.id, scheduledAt, input.again === true),
      });
    }

    await this.refuseDuplicates(workspaceId, posts, input.again === true, when.kind === "daily");
    return this.confirm(
      workspaceId,
      userId,
      clip.run.id,
      mode,
      timezone,
      posts,
      "publishing.post.created",
    );
  }

  /**
   * "Post one a day": the chosen clips on the chosen accounts, each on its own
   * day at `time`. A clip that already has a live post on an account, or has
   * no video that account takes, is left out of it and listed in `skipped`.
   */
  async daily(
    workspaceId: string,
    userId: string,
    runId: string,
    input: DailyPostsInput,
  ): Promise<
    PublishResultView & {
      readonly skipped: readonly { clipId: string; channelId: string; reason: string }[];
    }
  > {
    await this.requireEnabled(workspaceId, true);
    await this.requireReady(workspaceId);
    await this.requireRun(workspaceId, runId);
    const timezone = this.zoneOf(input.timezone, DEFAULT_TIME_ZONE);
    const clock = this.clockOf(input.time);
    if (input.startDate !== undefined && Number.isNaN(Date.parse(`${input.startDate}T00:00:00Z`))) {
      throw new AppException(
        PUBLISHING_ERRORS.timeInvalid,
        "That start date is not a date.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const clipIds = [...new Set(input.clipIds)];
    const rows = await this.prisma.repurposeClip.findMany({
      where: { id: { in: clipIds }, runId, run: { workspaceId } },
      include: RUN_CLIP_INCLUDE,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const clips = clipIds.map((id) => byId.get(id));
    if (clips.some((clip) => clip === undefined)) {
      throw new AppException(
        PUBLISHING_ERRORS.clipNotFound,
        "One of those clips is not in this run.",
        HttpStatus.NOT_FOUND,
      );
    }
    const { picked: channels, directory } = await this.pickChannels(workspaceId, input.channelIds);

    // Which clips can go to which account: a finished video it takes, not
    // removed, and no live post there already.
    const live = await this.prisma.publishTarget.findMany({
      where: {
        workspaceId,
        clipId: { in: clipIds },
        channelConnectionId: { in: channels.map((channel) => channel.connection.id) },
        status: { notIn: [...DEAD_STATES] },
      },
      select: { clipId: true, channelConnectionId: true },
    });
    const posted = new Set(live.map((row) => `${row.clipId}|${row.channelConnectionId ?? ""}`));
    const checks = await this.approvals.forClips(workspaceId, clipIds);
    const skipped: { clipId: string; channelId: string; reason: string }[] = [];
    let unapproved = 0;
    const eligible = new Map<
      string,
      { clip: RunClip; video: PlannedPost["video"]; text: PostText }[]
    >();
    for (const clip of clips as RunClip[]) {
      const videos = await clipVideos(this.prisma, clip.id);
      const durationMs = clip.mezzanineDurationMs ?? clip.sourceEndMs - clip.sourceStartMs;
      const words = this.wordsOf(clip);
      const check = checks.get(clip.id) ?? NOT_REQUIRED;
      for (const channel of channels) {
        const id = channel.connection.id;
        const skip = (reason: string): void => {
          skipped.push({ clipId: clip.id, channelId: id, reason });
        };
        if (clip.candidate.state === "rejected") {
          skip("This clip was removed.");
          continue;
        }
        if (posted.has(`${clip.id}|${id}`)) {
          skip("It already has a post on this account.");
          continue;
        }
        const { shape, blocker, approval } = this.approvedShapeFor(
          channel.provider,
          videos,
          check,
          durationMs,
        );
        if (approval !== null) {
          unapproved += 1;
          skip(approval);
          continue;
        }
        if (shape === null || blocker !== null) {
          skip(blocker ?? "No finished video with captions yet.");
          continue;
        }
        const text = defaultPostText(channel.provider, words);
        const problem = problemWithText(channel.provider, text);
        if (problem !== null) {
          skip(problem);
          continue;
        }
        const list = eligible.get(id) ?? [];
        list.push({ clip, video: shape, text });
        eligible.set(id, list);
      }
    }

    const used = await this.usedDays(
      workspaceId,
      directory,
      channels.map((channel) => channel.connection.id),
      timezone,
    );
    const posts: PlannedPost[] = [];
    for (const channel of channels) {
      const entries = eligible.get(channel.connection.id) ?? [];
      if (entries.length === 0) continue;
      const slots: DailySlot[] = planDaily({
        clipIds: entries.map((entry) => entry.clip.id),
        channelIds: [channel.connection.id],
        clock,
        timeZone: timezone,
        now: new Date(this.now()),
        ...(input.startDate === undefined ? {} : { startDay: input.startDate }),
        usedDays: used,
        minLeadMs: DAILY_MIN_LEAD_MS,
      });
      for (const slot of slots) {
        const entry = entries.find((candidate) => candidate.clip.id === slot.clipId);
        if (entry === undefined) continue;
        posts.push({
          clip: entry.clip,
          channel,
          video: entry.video,
          text: entry.text,
          settings: canonicalSettings(
            channel.provider,
            channel.integration.identifier,
            input.visibility,
          ),
          scheduledAt: slot.at,
          key: idempotencyKeyOf(entry.clip.id, channel.connection.id, slot.at, false),
        });
      }
    }
    if (posts.length === 0) {
      // Every pair left out for want of approval: say that, with its own code.
      if (unapproved > 0 && unapproved === skipped.length) {
        throw notApproved(
          clips.length === 1
            ? (skipped[0]?.reason ?? APPROVAL_MESSAGES.pending)
            : "None of these clips is approved yet. They need approval before they are posted.",
          { skipped },
        );
      }
      throw new AppException(
        PUBLISHING_ERRORS.notReady,
        skipped[0]?.reason ?? "None of these clips can be posted to these accounts yet.",
        HttpStatus.CONFLICT,
        { skipped },
      );
    }
    await this.refuseDuplicates(workspaceId, posts, false);
    const result = await this.confirm(
      workspaceId,
      userId,
      runId,
      "scheduled",
      timezone,
      posts,
      "publishing.daily.created",
    );
    return { ...result, skipped };
  }

  // -------------------------------------------------------------------------
  // Cancel and retry
  // -------------------------------------------------------------------------

  async cancel(workspaceId: string, userId: string, postId: string): Promise<PostView> {
    await this.requireEnabled(workspaceId, false);
    let row = await this.requirePost(workspaceId, postId);
    if (row.status === "cancelled") return toPostView(row);

    if (row.status === "scheduled") {
      if (!this.postiz.configured) {
        throw new AppException(
          PUBLISHING_ERRORS.notConfigured,
          "Posting is not set up any more, so this scheduled post cannot be reached to cancel it.",
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      // It may have gone out a moment ago: ask before deleting.
      await this.dispatcher.checkNow(row.id);
      row = await this.requirePost(workspaceId, postId);
      if (row.status === "scheduled" && row.externalPostId !== null) {
        try {
          await this.removeFromPostiz(row);
        } catch (error) {
          this.logger.warn(
            { postId, kind: isPostizError(error) ? error.kind : "unknown" },
            "could not delete a scheduled post in the publishing service",
          );
          throw new AppException(
            PUBLISHING_ERRORS.unavailable,
            "The publishing service could not be reached to cancel this. Try again in a minute.",
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }
      }
    }

    if (row.status === "published") {
      throw new AppException(
        PUBLISHING_ERRORS.notCancellable,
        `This is already posted. Remove it on ${this.platformOf(row.provider)} if it should not be there.`,
        HttpStatus.CONFLICT,
      );
    }
    if (row.status === "cancelled") return toPostView(row);
    if (row.status === "validating" || row.status === "submitted" || row.status === "processing") {
      throw new AppException(
        PUBLISHING_ERRORS.notCancellable,
        "This post is being sent right now. Wait a moment, then check it.",
        HttpStatus.CONFLICT,
      );
    }

    const { count } = await this.prisma.publishTarget.updateMany({
      where: { id: row.id, workspaceId, status: row.status },
      data: { status: "cancelled", nextCheckAt: null, retryAfter: null },
    });
    if (count === 0) {
      throw new AppException(
        PUBLISHING_ERRORS.notCancellable,
        "This post changed while you were cancelling it. Check it again.",
        HttpStatus.CONFLICT,
      );
    }
    // A failed post can still have a copy in Postiz (it errored there): tidy it.
    if (row.externalPostId !== null && row.status !== "scheduled") {
      await this.removeFromPostiz(row).catch(() => undefined);
    }
    await refreshBatch(this.prisma, row.batchId);
    await this.audit.record({
      action: "publishing.post.cancelled",
      resource: "publish_target",
      resourceId: row.id,
      actorId: userId,
      workspaceId,
      data: { provider: row.provider, was: row.status },
    });
    return toPostView(await this.requirePost(workspaceId, postId));
  }

  async retry(workspaceId: string, userId: string, postId: string): Promise<PostView> {
    await this.requireEnabled(workspaceId, false);
    await this.requireReady(workspaceId);
    const row = await this.requirePost(workspaceId, postId);
    if (row.status !== "failed_retryable" && row.status !== "action_required") {
      throw new AppException(
        PUBLISHING_ERRORS.notRetryable,
        row.status === "failed_permanent"
          ? "This post cannot go out as it is. Post the clip again with changes."
          : "Only a post that did not go out can be tried again.",
        HttpStatus.CONFLICT,
      );
    }
    // Its video was frozen when it was confirmed; it goes out again only while
    // the clip is still approved with that video.
    const check = await this.approvals.forClip(workspaceId, row.clipId);
    if (check.required && (row.exportId === null || !mayPost(check, row.exportId))) {
      throw notApproved(check.message ?? APPROVAL_MESSAGES.retry);
    }
    // The last attempt's post in Postiz (it errored, or never went out) goes
    // first, so the new attempt cannot end up beside it.
    if (row.externalPostId !== null) {
      try {
        await this.removeFromPostiz(row);
      } catch {
        throw new AppException(
          PUBLISHING_ERRORS.unavailable,
          "The publishing service could not be reached. Try again in a minute.",
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    }
    const attemptNo = row.attemptNo + 1;
    const { count } = await this.prisma.publishTarget.updateMany({
      where: { id: row.id, workspaceId, status: row.status, attemptNo: row.attemptNo },
      data: {
        status: "ready",
        attemptNo,
        lastErrorCode: null,
        lastErrorSafeMessage: null,
        retryAfter: null,
        externalPostId: null,
        externalUrl: null,
        externalStatus: null,
        submittedAt: null,
        checkNo: 0,
        nextCheckAt: null,
      },
    });
    if (count === 0) {
      throw new AppException(
        PUBLISHING_ERRORS.notRetryable,
        "This post is already being tried again.",
        HttpStatus.CONFLICT,
      );
    }
    await refreshBatch(this.prisma, row.batchId);
    await this.queue.dispatch({ targetId: row.id, attemptNo, workspaceId });
    await this.audit.record({
      action: "publishing.post.retried",
      resource: "publish_target",
      resourceId: row.id,
      actorId: userId,
      workspaceId,
      data: { provider: row.provider, attemptNo },
    });
    return toPostView(await this.requirePost(workspaceId, postId));
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Delete a post from Postiz. Postiz (v1.47) answers 500, not 404, for a post
   * it no longer has, so a 500 is checked against its list before it counts
   * as a failure: a post already gone is the state this was asked for.
   */
  private async removeFromPostiz(row: {
    readonly externalPostId: string | null;
    readonly scheduledAt: Date | null;
    readonly submittedAt: Date | null;
    readonly createdAt: Date;
  }): Promise<void> {
    const postId = row.externalPostId;
    if (postId === null) return;
    try {
      await this.postiz.deletePost(postId);
    } catch (error) {
      if (!isPostizError(error) || error.kind !== "server") throw error;
      const anchor = (row.scheduledAt ?? row.submittedAt ?? row.createdAt).getTime();
      const posts = await this.postiz.listPosts(
        new Date(Math.min(anchor, row.createdAt.getTime()) - 2 * 24 * 60 * 60_000),
        new Date(this.now() + 400 * 24 * 60 * 60_000),
      );
      if (posts.some((post) => post.id === postId)) throw error;
    }
  }

  private async statusWithChannels(
    workspaceId: string,
  ): Promise<{ readonly status: PublishingStatusView; readonly channels: DirectoryChannel[] }> {
    const access = await this.access.state(workspaceId);
    const postizUrl = access.enabled && access.allowed ? postizAppUrl() : null;
    const view = (reason: UnavailableReason | null, count: number): PublishingStatusView => ({
      enabled: access.enabled,
      available: reason === null,
      reason,
      // eslint-disable-next-line security/detect-object-injection -- a closed union key
      message: reason === null ? null : STATUS_MESSAGES[reason],
      postizUrl,
      channelCount: count,
    });
    if (access.reason !== null) return { status: view(access.reason, 0), channels: [] };
    try {
      const channels = await this.directory.sync(workspaceId, {
        tiktok: await this.access.tiktokEnabled(workspaceId),
      });
      const usable = channels.filter(
        (channel) => channel.provider !== null && channel.view.note === null,
      );
      return { status: view(usable.length === 0 ? "no_channels" : null, usable.length), channels };
    } catch (error) {
      const refused =
        isPostizError(error) && (error.kind === "unauthorized" || error.kind === "forbidden");
      this.logger.warn(
        { workspaceId, kind: isPostizError(error) ? error.kind : "unknown" },
        "could not list the publishing service's channels",
      );
      return { status: view(refused ? "key_refused" : "unreachable", 0), channels: [] };
    }
  }

  /**
   * 404 while the flag is off - the surface does not advertise itself, like
   * `repurpose_flow` - and, for a run's routes, while the run surface is off.
   */
  private async requireEnabled(workspaceId: string, run: boolean): Promise<void> {
    const enabled =
      (await this.access.flag(workspaceId, PUBLISHING_FLAGS.postiz)) &&
      (!run || (await this.access.flag(workspaceId, PUBLISHING_FLAGS.repurpose)));
    if (enabled) return;
    throw new AppException(
      PUBLISHING_ERRORS.disabled,
      "This feature is not available yet.",
      HttpStatus.NOT_FOUND,
    );
  }

  /** 503 unless this workspace may post and a key is set. */
  private async requireReady(workspaceId: string): Promise<void> {
    const access = await this.access.state(workspaceId);
    if (access.reason === null) return;
    throw new AppException(
      PUBLISHING_ERRORS.notConfigured,
      STATUS_MESSAGES[access.reason],
      HttpStatus.SERVICE_UNAVAILABLE,
      { reason: access.reason },
    );
  }

  private async requireRun(workspaceId: string, runId: string): Promise<void> {
    const run = await this.prisma.repurposeRun.findFirst({
      where: { id: runId, workspaceId },
      select: { id: true },
    });
    if (run === null) {
      throw new AppException(
        PUBLISHING_ERRORS.clipNotFound,
        "We could not find that video project.",
        HttpStatus.NOT_FOUND,
      );
    }
  }

  /** Workspace, run and clip together - never "find by id, then check". */
  private async requireClip(
    workspaceId: string,
    runId: string,
    clipId: string,
    forPosting: boolean,
  ): Promise<RunClip> {
    const clip = await this.prisma.repurposeClip.findFirst({
      where: { id: clipId, runId, run: { workspaceId } },
      include: RUN_CLIP_INCLUDE,
    });
    if (clip === null) {
      throw new AppException(
        PUBLISHING_ERRORS.clipNotFound,
        "We could not find that clip.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (forPosting && clip.candidate.state === "rejected") {
      throw new AppException(
        PUBLISHING_ERRORS.notReady,
        "This clip was removed. Bring it back first to post it.",
        HttpStatus.CONFLICT,
      );
    }
    return clip;
  }

  private async requirePost(workspaceId: string, postId: string) {
    const row = await this.prisma.publishTarget.findFirst({
      where: { id: postId, workspaceId },
      include: POST_INCLUDE,
    });
    if (row === null) {
      throw new AppException(
        PUBLISHING_ERRORS.postNotFound,
        "We could not find that post.",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  /** The chosen channels, each supported, switched on and still connected. */
  private async pickChannels(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<{ readonly picked: PickedChannel[]; readonly directory: DirectoryChannel[] }> {
    let list: DirectoryChannel[];
    try {
      list = await this.directory.sync(workspaceId, {
        tiktok: await this.access.tiktokEnabled(workspaceId),
      });
    } catch (error) {
      const refused =
        isPostizError(error) && (error.kind === "unauthorized" || error.kind === "forbidden");
      throw new AppException(
        PUBLISHING_ERRORS.unavailable,
        STATUS_MESSAGES[refused ? "key_refused" : "unreachable"],
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const picked: PickedChannel[] = [];
    for (const id of [...new Set(ids)]) {
      const channel = list.find((entry) => entry.connection?.id === id);
      if (channel === undefined || channel.connection === null || channel.provider === null) {
        throw new AppException(
          PUBLISHING_ERRORS.channelUnknown,
          "One of those accounts is no longer connected. Open the list again and pick again.",
          HttpStatus.BAD_REQUEST,
          { channelId: id },
        );
      }
      if (channel.view.note !== null) {
        throw new AppException(
          PUBLISHING_ERRORS.channelUnavailable,
          `${channel.view.name}: ${channel.view.note}`,
          HttpStatus.BAD_REQUEST,
          { channelId: id },
        );
      }
      picked.push({ ...channel, provider: channel.provider, connection: channel.connection });
    }
    return { picked, directory: list };
  }

  /**
   * The video a platform gets for this clip. `blocker` says why it cannot be
   * posted there at all; `info` explains a fallback that still posts.
   */
  private shapeFor(
    provider: SupportedProvider,
    videos: ReadonlyMap<VideoShape, ShapeVideo>,
    clipDurationMs: number | null,
  ): {
    readonly shape: PlannedPost["video"] | null;
    readonly blocker: string | null;
    readonly info: string | null;
  } {
    const ready = new Set<VideoShape>();
    const making = new Set<VideoShape>();
    for (const [shape, video] of videos) {
      if (video.state === "ready" && video.export !== null) ready.add(shape);
      else if (video.state === "making") making.add(shape);
    }
    const choice = chooseShape(provider, ready, making);
    if (choice.shape === null) {
      const stale = [...videos.values()].some((video) => video.state === "stale");
      return {
        shape: null,
        blocker: stale
          ? "Its captions changed after the video was made. Export it again from the editor."
          : (choice.note ?? "No finished video with captions yet."),
        info: null,
      };
    }
    const video = videos.get(choice.shape) as PlannedPost["video"];
    const tooLong = tooLongFor(provider, video.export.durationMs ?? clipDurationMs);
    if (tooLong !== null) return { shape: null, blocker: tooLong, info: null };
    return { shape: video, blocker: null, info: choice.note };
  }

  /**
   * {@link shapeFor} under the approval rule: only a video the approval pinned
   * counts, so a platform whose preferred shape was made or changed after the
   * approval gets a covered one instead. `approval` says why nothing can go when
   * the rule is what stops it: the clip is not approved, or no video it takes is
   * one the approval covers.
   */
  private approvedShapeFor(
    provider: SupportedProvider,
    videos: ReadonlyMap<VideoShape, ShapeVideo>,
    check: ApprovalCheck,
    clipDurationMs: number | null,
  ): ReturnType<PublishingService["shapeFor"]> & { readonly approval: string | null } {
    if (check.required && check.message !== null) {
      return { shape: null, blocker: check.message, info: null, approval: check.message };
    }
    if (!check.required) {
      return { ...this.shapeFor(provider, videos, clipDurationMs), approval: null };
    }
    const covered = new Map<VideoShape, ShapeVideo>();
    for (const [shape, video] of videos) {
      covered.set(
        shape,
        video.export !== null && !mayPost(check, video.export.id)
          ? { ...video, state: "none", export: null }
          : video,
      );
    }
    const approved = this.shapeFor(provider, covered, clipDurationMs);
    if (approved.shape !== null) return { ...approved, approval: null };
    // Nothing covered fits: say so only when something uncovered would have.
    return this.shapeFor(provider, videos, clipDurationMs).shape === null
      ? { ...approved, approval: null }
      : {
          shape: null,
          blocker: APPROVAL_MESSAGES.changed,
          info: null,
          approval: APPROVAL_MESSAGES.changed,
        };
  }

  private wordsOf(clip: RunClip): ClipWords {
    return {
      title: clip.title,
      copy: clip.copy,
      sourceUrl: fullEpisodeUrl(clip.run.sourceFingerprint),
    };
  }

  /** The person's text for a platform, trimmed, or the default. */
  private textFor(
    provider: SupportedProvider,
    edited: { readonly title?: string | undefined; readonly body: string } | undefined,
    words: ClipWords,
  ): PostText {
    const fallback = defaultPostText(provider, words);
    if (edited === undefined) return fallback;
    const hasTitle = rulesFor(provider).titleLimit !== null;
    return {
      title: hasTitle ? (edited.title ?? fallback.title ?? "").trim() : null,
      body: edited.body.replace(/\r\n?/g, "\n").trim(),
    };
  }

  private zoneOf(value: string | undefined, fallback: string): string {
    if (value === undefined || value.trim() === "") return fallback;
    if (!isTimeZone(value)) {
      throw new AppException(
        PUBLISHING_ERRORS.timeInvalid,
        "That time zone is not one we know.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return value;
  }

  private clockOf(value: string | undefined): Clock {
    const clock = parseClock(value ?? DEFAULT_DAILY_TIME);
    if (clock === null) {
      throw new AppException(
        PUBLISHING_ERRORS.timeInvalid,
        "Pick a time of day between 00:00 and 23:59.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return clock;
  }

  private platformOf(provider: string): string {
    const known = ["instagram", "facebook", "youtube", "tiktok", "linkedin", "x", "threads"];
    return known.includes(provider)
      ? rulesFor(provider as SupportedProvider).label
      : "that platform";
  }

  /**
   * The days each channel already posts on, in `timeZone`: Aksharo's own live
   * posts, and - best effort - whatever is in Postiz for that account, so a
   * post scheduled there by hand is not doubled up.
   */
  private async usedDays(
    workspaceId: string,
    channels: readonly DirectoryChannel[],
    connectionIds: readonly string[],
    timeZone: string,
  ): Promise<Map<string, Set<string>>> {
    const used = new Map<string, Set<string>>(connectionIds.map((id) => [id, new Set<string>()]));
    const since = new Date(this.now() - 24 * 60 * 60_000);
    const rows = await this.prisma.publishTarget.findMany({
      where: {
        workspaceId,
        channelConnectionId: { in: [...connectionIds] },
        status: { notIn: [...DEAD_STATES] },
        OR: [{ scheduledAt: { gte: since } }, { scheduledAt: null, createdAt: { gte: since } }],
      },
      select: { channelConnectionId: true, scheduledAt: true, createdAt: true },
    });
    for (const row of rows) {
      if (row.channelConnectionId === null) continue;
      used.get(row.channelConnectionId)?.add(dayInZone(row.scheduledAt ?? row.createdAt, timeZone));
    }
    try {
      const posts = await this.postiz.listPosts(
        since,
        new Date(this.now() + 400 * 24 * 60 * 60_000),
      );
      for (const post of posts) {
        const state = post.state.toUpperCase();
        if (state !== "QUEUE" && state !== "PUBLISHED") continue;
        const channel = channels.find(
          (entry) => entry.integration.id === post.integration?.id && entry.connection !== null,
        );
        const at = Date.parse(post.publishDate);
        if (channel?.connection === undefined || channel.connection === null || Number.isNaN(at))
          continue;
        used.get(channel.connection.id)?.add(dayInZone(new Date(at), timeZone));
      }
    } catch (error) {
      this.logger.warn(
        { kind: isPostizError(error) ? error.kind : "unknown" },
        "could not read the publishing service's calendar; planning from Aksharo's posts only",
      );
    }
    return used;
  }

  /**
   * 409 when a post for the same clip, account and slot is already live - and,
   * for "one a day", when the clip already has any live post on that account:
   * the next free day would otherwise quietly post it a second time.
   */
  private async refuseDuplicates(
    workspaceId: string,
    posts: readonly PlannedPost[],
    again: boolean,
    anySlot = false,
  ): Promise<void> {
    if (again) return;
    const existing = await this.prisma.publishTarget.findMany({
      where: {
        workspaceId,
        status: { notIn: [...DEAD_STATES] },
        ...(anySlot
          ? {
              clipId: { in: [...new Set(posts.map((post) => post.clip.id))] },
              channelConnectionId: { in: posts.map((post) => post.channel.connection.id) },
            }
          : { idempotencyKey: { in: posts.map((post) => post.key) } }),
      },
      select: { idempotencyKey: true, clipId: true, channelConnectionId: true },
    });
    if (existing.length === 0) return;
    const taken = posts.filter((post) =>
      existing.some((row) =>
        anySlot
          ? row.clipId === post.clip.id && row.channelConnectionId === post.channel.connection.id
          : row.idempotencyKey === post.key,
      ),
    );
    const names = taken.map((post) => post.channel.view.name).join(", ");
    const now = taken.every((post) => post.scheduledAt === null);
    throw new AppException(
      PUBLISHING_ERRORS.alreadyPosted,
      anySlot
        ? `This clip already has a post on ${names}. Pick a time instead to post it there again.`
        : now
          ? `This clip is already posted, or being posted, on ${names}.`
          : `This clip already has a post on ${names} at that time.`,
      HttpStatus.CONFLICT,
      { channels: taken.map((post) => post.channel.connection.id) },
    );
  }

  /** Freeze the posts, one batch, then hand them to the queue. */
  private async confirm(
    workspaceId: string,
    userId: string,
    runId: string,
    mode: $Enums.PublishBatchMode,
    timezone: string,
    posts: readonly PlannedPost[],
    action: string,
  ): Promise<PublishResultView> {
    const batchId = ulid();
    const ids = posts.map(() => ulid());
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.publishBatch.create({
          data: {
            id: batchId,
            runId,
            workspaceId,
            confirmedBy: userId,
            mode,
            timezone,
            status: "pending",
            targetCount: posts.length,
          },
        });
        for (const [index, post] of posts.entries()) {
          await tx.publishTarget.create({
            data: {
              // eslint-disable-next-line security/detect-object-injection -- a numeric index into our own array
              id: ids[index] as string,
              workspaceId,
              batchId,
              clipId: post.clip.id,
              variantId: post.video.variantId,
              channelConnectionId: post.channel.connection?.id ?? null,
              provider: post.channel.provider,
              publishMode: post.scheduledAt === null ? "direct" : "schedule",
              scheduledAt: post.scheduledAt,
              copy: {
                schemaVersion: PUBLISHING_SCHEMA_VERSION,
                title: post.text.title,
                body: post.text.body,
                hashtags: hashtagsIn(post.text.body).slice(0, 100),
                locale: localeOf(post.clip.copy),
              },
              settings: post.settings as unknown as Prisma.InputJsonObject,
              artifactFingerprint: artifactFingerprint(post.video.export),
              exportId: post.video.export.id,
              status: "ready",
              attemptNo: 1,
              idempotencyKey: post.key,
            },
          });
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppException(
          PUBLISHING_ERRORS.alreadyPosted,
          "This clip already has a post for one of those accounts at that time.",
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }

    await this.audit.record({
      action,
      resource: "publish_batch",
      resourceId: batchId,
      actorId: userId,
      workspaceId,
      data: {
        runId,
        mode,
        posts: posts.map((post) => ({
          clipId: post.clip.id,
          provider: post.channel.provider,
          shape: post.video.shape,
          at: post.scheduledAt?.toISOString() ?? "now",
        })),
      },
    });
    // Straight to the queue, so "now" means now; a failed enqueue is the watchdog's.
    for (const targetId of ids) {
      await this.queue.dispatch({ targetId, attemptNo: 1, workspaceId });
    }
    const rows = await this.prisma.publishTarget.findMany({
      where: { id: { in: ids }, workspaceId },
      include: POST_INCLUDE,
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
    });
    return { batchId, posts: rows.map(toPostView) };
  }
}

/** 409 `publishing/not_approved`, with the sentence the Post dialog shows. */
function notApproved(message: string, details?: Record<string, unknown>): AppException {
  return new AppException(PUBLISHING_ERRORS.notApproved, message, HttpStatus.CONFLICT, details);
}
