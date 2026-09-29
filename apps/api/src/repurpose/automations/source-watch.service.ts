import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { CHANNEL_URL_MESSAGES, channelLink, parseChannelUrl } from "./channel-url.js";
import {
  AUTOMATIONS_FLAG,
  AUTOMATION_ERRORS,
  MAX_WATCHES_PER_WORKSPACE,
  SOURCE_WATCH_TASK,
  WATCH_STATE_MESSAGES,
  WATCH_STATE_REASONS,
} from "./source-watch.constants.js";
import { runSetupSchema } from "./source-watch.dto.js";
import { CHANNEL_DIRECTORY, ChannelLookupError } from "./youtube-channels.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, PrismaService } from "../../common/index.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { StylesService } from "../../styles/styles.service.js";
import { REPURPOSE_ERRORS, REPURPOSE_FLAGS } from "../repurpose.constants.js";
import { RepurposeService, isUniqueViolation } from "../repurpose.service.js";

import type { WatchStateReason } from "./source-watch.constants.js";
import type {
  CreateWatchInput,
  ResolvedChannelView,
  UpdateWatchInput,
  WatchList,
  WatchSetup,
  WatchVideoView,
  WatchView,
} from "./source-watch.dto.js";
import type { ChannelDirectory, ResolvedChannel } from "./youtube-channels.js";
import type { Prisma, SourceWatch, SourceWatchVideo } from "@prisma/client";

/** How many of a watch's most recent uploads its view lists. */
const VIDEOS_PER_WATCH = 10;

/** Roles a watch's runs may be started as: anyone who could start one by hand. */
export const STARTING_ROLES = ["owner", "admin", "editor"] as const;

type VideoWithRun = SourceWatchVideo & { readonly run: { readonly status: string } | null };

/**
 * Channel automations (2026-10-02): connect a YouTube channel once, and every
 * new upload becomes clips on Autopilot. This service is the person's side -
 * connect, list, change, pause, resume, remove; `source-watch.poller.ts` is the
 * scheduled side that reads feeds and starts runs.
 *
 * What it is careful about:
 *
 *   * **Three flags.** `repurpose_automations` (a missing row is off), and the
 *     two a link run needs anyway: `repurpose_flow` and
 *     `source_youtube_acquire`. Any one off, every route answers 404.
 *   * **Every lookup is `(workspaceId, watchId)`**, as runs are: no "find by id
 *     and then check".
 *   * **The setup is validated when it is saved**, with the start form's own
 *     schema plus a watch's two refusals, and its caption look against the
 *     workspace's catalogue - so a person hears about a bad setup now, not in a
 *     week when the next episode fails to start.
 *   * **YouTube is asked as little as possible**: resolving a link reads one
 *     page (or one feed, for a `/channel/UC…` link), through the cached,
 *     gate-respecting directory; saving reuses that answer.
 *   * **Every change is audited** (`repurpose.watch.*`).
 */
@Injectable()
export class SourceWatchService {
  private readonly logger = new Logger(SourceWatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RepurposeService,
    private readonly styles: StylesService,
    private readonly audit: CommonAuditService,
    private readonly scheduler: ScheduledTasksService,
    @Inject(CHANNEL_DIRECTORY) private readonly directory: ChannelDirectory,
  ) {}

  /** All three flags on for this workspace. */
  async enabled(workspaceId: string): Promise<boolean> {
    for (const flag of [AUTOMATIONS_FLAG, REPURPOSE_FLAGS.flow, REPURPOSE_FLAGS.youtubeAcquire]) {
      if (!(await this.runs.flagEnabled(workspaceId, flag))) return false;
    }
    return true;
  }

  /** 404 while the surface is off, like every clips route: it does not advertise itself. */
  async assertAvailable(workspaceId: string): Promise<void> {
    if (await this.enabled(workspaceId)) return;
    throw new AppException(
      AUTOMATION_ERRORS.disabled,
      "Automations are not available yet.",
      HttpStatus.NOT_FOUND,
    );
  }

  /** Which channel a link is, for the form's preview. Reads YouTube (cached). */
  async resolve(workspaceId: string, url: string): Promise<ResolvedChannelView> {
    await this.assertAvailable(workspaceId);
    const channel = await this.lookUp(url);
    const existing = await this.prisma.sourceWatch.findUnique({
      where: { workspaceId_channelId: { workspaceId, channelId: channel.channelId } },
      select: { id: true },
    });
    return {
      channelId: channel.channelId,
      title: channel.title,
      handle: channel.handle,
      channelUrl: channelLink(channel.channelId),
      watchId: existing?.id ?? null,
    };
  }

  async create(workspaceId: string, userId: string, input: CreateWatchInput): Promise<WatchView> {
    await this.assertAvailable(workspaceId);
    const parsed = parseChannelUrl(input.url);
    if (!parsed.ok) throw invalidChannelUrl(parsed.code);
    await this.assertStyle(workspaceId, input.setup);

    const count = await this.prisma.sourceWatch.count({ where: { workspaceId } });
    if (count >= MAX_WATCHES_PER_WORKSPACE) {
      throw new AppException(
        AUTOMATION_ERRORS.watchLimit,
        `A workspace can follow up to ${String(MAX_WATCHES_PER_WORKSPACE)} channels. Remove one to add another.`,
        HttpStatus.CONFLICT,
        { maxWatches: MAX_WATCHES_PER_WORKSPACE },
      );
    }

    const channel = await this.lookUp(input.url);
    const existing = await this.prisma.sourceWatch.findUnique({
      where: { workspaceId_channelId: { workspaceId, channelId: channel.channelId } },
      select: { id: true },
    });
    if (existing !== null) throw watchExists(existing.id);

    const now = new Date();
    let watch: SourceWatch;
    try {
      watch = await this.prisma.sourceWatch.create({
        data: {
          id: ulid(),
          workspaceId,
          kind: "youtube_channel",
          channelId: channel.channelId,
          title: channel.title,
          handle: channel.handle,
          setup: storedSetup(input.setup),
          backfillCount: input.backfill,
          state: "active",
          stateChangedAt: now,
          // The first check is the next tick's, not an hour away.
          nextCheckAt: now,
          rightsAttestedAt: now,
          rightsAttestedBy: userId,
          createdBy: userId,
        },
      });
    } catch (error) {
      // Two saves of one channel at once: the unique index let one through.
      if (isUniqueViolation(error)) {
        const winner = await this.prisma.sourceWatch.findUnique({
          where: { workspaceId_channelId: { workspaceId, channelId: channel.channelId } },
          select: { id: true },
        });
        if (winner !== null) throw watchExists(winner.id);
      }
      throw error;
    }

    await this.audit.record({
      action: "repurpose.watch.created",
      resource: "source_watch",
      resourceId: watch.id,
      actorId: userId,
      workspaceId,
      data: {
        kind: watch.kind,
        channelId: watch.channelId,
        backfill: watch.backfillCount,
        automation: "auto",
        rightsAttestedAt: now.toISOString(),
      },
    });
    return this.viewOf(watch, [], 0);
  }

  async list(workspaceId: string): Promise<WatchList> {
    await this.assertAvailable(workspaceId);
    const watches = await this.prisma.sourceWatch.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    const ids = watches.map((watch) => watch.id);
    const started =
      ids.length === 0
        ? []
        : await this.prisma.sourceWatchVideo.groupBy({
            by: ["watchId"],
            where: { watchId: { in: ids }, state: "started" },
            _count: { _all: true },
          });
    const counts = new Map(started.map((row) => [row.watchId, row._count._all]));
    // Each watch's own latest uploads, one small indexed read at a time (at most
    // MAX_WATCHES_PER_WORKSPACE): one busy channel's Shorts cannot crowd another's
    // episodes out of a shared page, and the pool is never asked for twenty at once.
    const items: WatchView[] = [];
    for (const watch of watches) {
      const videos = await this.prisma.sourceWatchVideo.findMany({
        where: { watchId: watch.id },
        orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
        take: VIDEOS_PER_WATCH,
        include: { run: { select: { status: true } } },
      });
      items.push(this.viewOf(watch, videos, counts.get(watch.id) ?? 0));
    }
    return {
      items,
      checksEnabled: this.scheduler.scheduled.includes(SOURCE_WATCH_TASK),
      maxWatches: MAX_WATCHES_PER_WORKSPACE,
    };
  }

  async get(workspaceId: string, watchId: string): Promise<WatchView> {
    await this.assertAvailable(workspaceId);
    return this.fullView(await this.watchOf(workspaceId, watchId));
  }

  /** New settings for the runs it starts from now on; runs already started keep theirs. */
  async update(
    workspaceId: string,
    userId: string,
    watchId: string,
    input: UpdateWatchInput,
  ): Promise<WatchView> {
    await this.assertAvailable(workspaceId);
    const watch = await this.watchOf(workspaceId, watchId);
    await this.assertStyle(workspaceId, input.setup);
    const updated = await this.prisma.sourceWatch.update({
      where: { id: watch.id },
      data: { setup: storedSetup(input.setup) },
    });
    await this.audit.record({
      action: "repurpose.watch.updated",
      resource: "source_watch",
      resourceId: watch.id,
      actorId: userId,
      workspaceId,
      data: { styleId: input.setup.caption.styleId, sourceLanguage: input.setup.sourceLanguage },
    });
    return this.fullView(updated);
  }

  /** Stop reading the channel until someone resumes it. Pausing a paused watch changes nothing. */
  async pause(workspaceId: string, userId: string, watchId: string): Promise<WatchView> {
    await this.assertAvailable(workspaceId);
    const watch = await this.watchOf(workspaceId, watchId);
    if (watch.state !== "active") return this.fullView(watch);
    const now = new Date();
    await this.prisma.sourceWatch.updateMany({
      where: { id: watch.id, state: "active" },
      data: { state: "paused", stateReason: "person", stateChangedAt: now },
    });
    await this.audit.record({
      action: "repurpose.watch.paused",
      resource: "source_watch",
      resourceId: watch.id,
      actorId: userId,
      workspaceId,
      data: { reason: "person" },
    });
    return this.fullView(await this.watchOf(workspaceId, watchId));
  }

  /**
   * Read it again from the next tick. A watch paused for credits picks up the
   * video it could not start - that video is still `pending` - and one whose
   * channel had gone is asked about again.
   *
   * @throws AppException 409 `repurpose/watch_creator_gone` when the person its
   *   runs are started as is no longer an editor here: their attestation does
   *   not pass to whoever presses Resume. Remove it and connect the channel again.
   */
  async resume(workspaceId: string, userId: string, watchId: string): Promise<WatchView> {
    await this.assertAvailable(workspaceId);
    const watch = await this.watchOf(workspaceId, watchId);
    if (watch.state === "active") return this.fullView(watch);
    if (!(await this.canStartAs(workspaceId, watch.createdBy))) {
      throw new AppException(
        AUTOMATION_ERRORS.creatorGone,
        WATCH_STATE_MESSAGES.creator_left,
        HttpStatus.CONFLICT,
      );
    }
    const now = new Date();
    await this.prisma.sourceWatch.updateMany({
      where: { id: watch.id, state: watch.state },
      data: {
        state: "active",
        stateReason: null,
        stateChangedAt: now,
        nextCheckAt: now,
        checkFailures: 0,
        lastErrorCode: null,
      },
    });
    await this.audit.record({
      action: "repurpose.watch.resumed",
      resource: "source_watch",
      resourceId: watch.id,
      actorId: userId,
      workspaceId,
      data: { from: watch.state, reason: watch.stateReason },
    });
    return this.fullView(await this.watchOf(workspaceId, watchId));
  }

  /** Stop following the channel. Runs it started are the workspace's and stay. */
  async remove(workspaceId: string, userId: string, watchId: string): Promise<{ id: string }> {
    await this.assertAvailable(workspaceId);
    const watch = await this.watchOf(workspaceId, watchId);
    await this.prisma.sourceWatch.deleteMany({ where: { id: watch.id, workspaceId } });
    await this.audit.record({
      action: "repurpose.watch.deleted",
      resource: "source_watch",
      resourceId: watch.id,
      actorId: userId,
      workspaceId,
      data: { channelId: watch.channelId },
    });
    return { id: watch.id };
  }

  /** The person runs are started as is still an editor (or more) of the workspace. */
  async canStartAs(workspaceId: string, userId: string): Promise<boolean> {
    const membership = await this.prisma.membership.findFirst({
      where: {
        workspaceId,
        userId,
        status: "active",
        role: { in: [...STARTING_ROLES] },
        user: { deletedAt: null },
      },
      select: { id: true },
    });
    return membership !== null;
  }

  private async watchOf(workspaceId: string, watchId: string): Promise<SourceWatch> {
    const watch = await this.prisma.sourceWatch.findFirst({ where: { id: watchId, workspaceId } });
    if (watch === null) {
      throw new AppException(
        AUTOMATION_ERRORS.notFound,
        "That automation does not exist.",
        HttpStatus.NOT_FOUND,
      );
    }
    return watch;
  }

  private async fullView(watch: SourceWatch): Promise<WatchView> {
    const [videos, runsStarted] = await Promise.all([
      this.prisma.sourceWatchVideo.findMany({
        where: { watchId: watch.id },
        orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
        take: VIDEOS_PER_WATCH,
        include: { run: { select: { status: true } } },
      }),
      this.prisma.sourceWatchVideo.count({ where: { watchId: watch.id, state: "started" } }),
    ]);
    return this.viewOf(watch, videos, runsStarted);
  }

  private viewOf(
    watch: SourceWatch,
    videos: readonly VideoWithRun[],
    runsStarted: number,
  ): WatchView {
    const reason = stateReasonOf(watch.stateReason);
    return {
      id: watch.id,
      kind: "youtube_channel",
      channelId: watch.channelId,
      channelUrl: channelLink(watch.channelId),
      title: watch.title,
      handle: watch.handle,
      state: watch.state,
      stateReason: watch.state === "active" ? null : reason,
      message: watch.state === "active" ? null : stateMessage(reason),
      setup: setupOf(watch.setup),
      backfillCount: watch.backfillCount,
      lastCheckedAt: watch.lastCheckedAt?.toISOString() ?? null,
      nextCheckAt: watch.state === "active" ? watch.nextCheckAt.toISOString() : null,
      lastErrorCode: watch.lastErrorCode,
      runsStarted,
      videos: videos.map(videoViewOf),
      createdBy: watch.createdBy,
      createdAt: watch.createdAt.toISOString(),
      updatedAt: watch.updatedAt.toISOString(),
    };
  }

  /** The chosen caption look exists in this workspace's catalogue (the start form's own rule). */
  private async assertStyle(workspaceId: string, setup: WatchSetup): Promise<void> {
    const catalogue = await this.styles.list(workspaceId);
    if (catalogue.some((style) => style.id === setup.caption.styleId)) return;
    throw new AppException(
      REPURPOSE_ERRORS.styleUnknown,
      "That caption look is not available. Choose another one.",
      HttpStatus.BAD_REQUEST,
    );
  }

  /** A link to the channel it names, or the refusal a person can act on. */
  private async lookUp(url: string): Promise<ResolvedChannel> {
    const parsed = parseChannelUrl(url);
    if (!parsed.ok) throw invalidChannelUrl(parsed.code);
    try {
      return await this.directory.resolve(parsed.channel);
    } catch (error) {
      if (!(error instanceof ChannelLookupError)) throw error;
      this.logger.log({ code: error.code, key: parsed.channel.key }, "channel lookup refused");
      throw lookupRefusal(error);
    }
  }
}

/** What a watch stores: the setup as validated, always on Autopilot. */
export function storedSetup(setup: WatchSetup): Prisma.InputJsonValue {
  return { ...setup, automation: "auto" } as unknown as Prisma.InputJsonValue;
}

/** A stored setup read back; one that no longer parses is shown as saved. */
function setupOf(stored: Prisma.JsonValue): WatchView["setup"] {
  const parsed = runSetupSchema.safeParse(stored);
  return parsed.success ? parsed.data : (stored as unknown as WatchView["setup"]);
}

/** The sentence for a watch that is not active; a reason it does not know reads as paused. */
function stateMessage(reason: WatchStateReason | null): string {
  if (reason === null) return WATCH_STATE_MESSAGES.person;
  // eslint-disable-next-line security/detect-object-injection -- a WatchStateReason, one of the table's keys
  return WATCH_STATE_MESSAGES[reason];
}

function stateReasonOf(value: string | null): WatchStateReason | null {
  return (WATCH_STATE_REASONS as readonly string[]).includes(value ?? "")
    ? (value as WatchStateReason)
    : null;
}

function videoViewOf(video: VideoWithRun): WatchVideoView {
  return {
    videoId: video.videoId,
    title: video.title,
    publishedAt: video.publishedAt.toISOString(),
    state: video.state,
    reason: video.reason,
    backfill: video.backfill,
    runId: video.runId,
    runStatus: video.run?.status ?? null,
  };
}

function invalidChannelUrl(code: keyof typeof CHANNEL_URL_MESSAGES): AppException {
  return new AppException(
    AUTOMATION_ERRORS.channelUrlInvalid,
    // eslint-disable-next-line security/detect-object-injection -- a ChannelUrlRejection, one of the table's keys
    CHANNEL_URL_MESSAGES[code],
    HttpStatus.BAD_REQUEST,
    { reason: code },
  );
}

function watchExists(watchId: string): AppException {
  return new AppException(
    AUTOMATION_ERRORS.watchExists,
    "This workspace already follows that channel.",
    HttpStatus.CONFLICT,
    { watchId },
  );
}

/** A directory refusal in the person's words. */
export function lookupRefusal(error: ChannelLookupError): AppException {
  switch (error.code) {
    case "not_found":
      return new AppException(
        AUTOMATION_ERRORS.channelNotFound,
        "We could not find that channel on YouTube. Check the link.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    case "busy":
      return new AppException(
        AUTOMATION_ERRORS.youtubeBusy,
        "YouTube is not answering this server right now. Try again in a while.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    default:
      return new AppException(
        AUTOMATION_ERRORS.channelUnreadable,
        "We could not read that channel from YouTube just now. Try again in a minute.",
        HttpStatus.BAD_GATEWAY,
      );
  }
}
