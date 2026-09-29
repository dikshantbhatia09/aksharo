import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";

import { cleanTitle } from "./channel-feed.js";
import {
  SOURCE_WATCH_TASK,
  SOURCE_WATCH_TICK_MS,
  WATCHES_PER_TICK,
  WATCH_CLAIM_STALE_MS,
  WATCH_FETCH_SPACING_MS,
  WATCH_NOT_FOUND_LIMIT,
  WATCH_STARTS_PER_CHECK,
  WATCH_START_ATTEMPTS,
} from "./source-watch.constants.js";
import { watchSetupSchema } from "./source-watch.dto.js";
import { SourceWatchService } from "./source-watch.service.js";
import { WatchNotifier } from "./watch-notices.js";
import { nextCheckAfterFailure, nextCheckAfterRead, planFeed, seenOf } from "./watch-plan.js";
import { CHANNEL_DIRECTORY, ChannelLookupError } from "./youtube-channels.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { REPURPOSE_ERRORS } from "../repurpose.constants.js";
import { createRunSchema } from "../repurpose.dto.js";
import { RepurposeService, isRefusal } from "../repurpose.service.js";

import type { WatchStateReason } from "./source-watch.constants.js";
import type { WatchSetup } from "./source-watch.dto.js";
import type { ChannelDirectory, ChannelLookupErrorCode } from "./youtube-channels.js";
import type { SourceWatch, SourceWatchVideo } from "@prisma/client";

/** A run's title is the start form's (`shortLabel`, 160 characters). */
const RUN_TITLE_MAX = 160;

/** What starting one video came to. `stop` ends this check's starts for the watch. */
type StartOutcome = "started" | "linked" | "lost" | "failed" | "stop";

/** What one watch's check came to, for the tick's report. */
type CheckOutcome =
  | { readonly kind: "read"; readonly recorded: number; readonly started: number }
  | { readonly kind: "paused"; readonly reason: WatchStateReason }
  | { readonly kind: "failed"; readonly code: ChannelLookupErrorCode }
  | { readonly kind: "busy" }
  | { readonly kind: "gone" };

export interface SourceWatchTickReport {
  /** Due watches this tick looked at. */
  readonly due: number;
  /** Feeds read. */
  readonly read: number;
  /** Uploads recorded (new, skipped or asked for at creation). */
  readonly recorded: number;
  readonly started: number;
  readonly paused: number;
  readonly failedReads: number;
  /** YouTube refused (or the gate was shut): the tick stopped reading. */
  readonly busy: boolean;
  /** Another tick was still running: this one did nothing. */
  readonly overlapped: boolean;
}

/**
 * The scheduled half of channel automations (2026-10-02): the
 * `repurpose.source-watch` task. Every fifteen minutes it reads the feeds of
 * the watches that are due - each at most once an hour, with jitter - records
 * what is new, and starts an Autopilot run for up to two new uploads per watch,
 * through `RepurposeService.create`: the start form's own path, so credits,
 * plan limits, windows, lanes and the YouTube gate all apply unchanged.
 *
 * **Inert until switched on.** Production runs only the tasks named in
 * `MONTAJ_SCHEDULER_TASKS`; this one runs nowhere until the operator adds
 * `repurpose.source-watch` there. And per workspace, only while
 * `repurpose_automations`, `repurpose_flow` and `source_youtube_acquire` are on.
 *
 * **Polite to YouTube.** At most {@link WATCHES_PER_TICK} feeds a tick, two
 * seconds apart, through the gate-respecting directory: while `SourceGate` is
 * open or half-open nothing is read, and a 429 trips it and ends the tick.
 *
 * **One run per upload, whatever crashes.** A video is a row before it is a
 * run (`source_watch_videos`, unique per watch and video). Starting one claims
 * the row first (`pending` -> `starting`, a conditional update only one poll
 * can win), then creates the run, then files the run on the row. A crash in
 * between leaves a claim that the next check resolves: the run exists (found
 * by the video's fingerprint, made after the claim), or the row is `pending`
 * again - and if a run of that video is still live, `create` itself refuses a
 * second (`repurpose_runs_live_source_idx`) and the row is filed against it.
 *
 * **Out of credits pauses the watch**, once, with a notice; resuming it starts
 * the video that could not be, which stayed `pending`.
 */
@Injectable()
export class SourceWatchPoller implements OnModuleInit {
  private readonly logger = new Logger(SourceWatchPoller.name);
  private running = false;

  /** Test seams: the clock, the pause between reads, and the jitter's dice. */
  clock: () => Date = () => new Date();
  sleep: (ms: number) => Promise<void> = async (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  random: () => number = Math.random;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RepurposeService,
    private readonly watches: SourceWatchService,
    private readonly notices: WatchNotifier,
    private readonly audit: CommonAuditService,
    private readonly scheduler: ScheduledTasksService,
    @Inject(CHANNEL_DIRECTORY) private readonly directory: ChannelDirectory,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: SOURCE_WATCH_TASK,
      everyMs: SOURCE_WATCH_TICK_MS,
      run: async () => {
        const report = await this.tick();
        if (report.read > 0 || report.started > 0 || report.paused > 0 || report.busy) {
          this.logger.log(report, "channel automations checked");
        }
      },
    });
  }

  /** One pass over the due watches. Never throws for one watch's trouble. */
  async tick(): Promise<SourceWatchTickReport> {
    const report = {
      due: 0,
      read: 0,
      recorded: 0,
      started: 0,
      paused: 0,
      failedReads: 0,
      busy: false,
      overlapped: false,
    };
    // A slow tick must not overlap the next one; the claims would hold, but
    // two ticks would read the same feeds.
    if (this.running) return { ...report, overlapped: true };
    this.running = true;
    try {
      const due = await this.prisma.sourceWatch.findMany({
        where: {
          state: "active",
          nextCheckAt: { lte: this.clock() },
          workspace: { deletedAt: null },
        },
        orderBy: [{ nextCheckAt: "asc" }, { id: "asc" }],
        take: WATCHES_PER_TICK,
      });
      report.due = due.length;
      const enabled = new Map<string, boolean>();
      let reads = 0;
      const pace = async (): Promise<void> => {
        if (reads > 0) await this.sleep(WATCH_FETCH_SPACING_MS);
        reads += 1;
      };

      for (const watch of due) {
        let on = enabled.get(watch.workspaceId);
        if (on === undefined) {
          on = await this.watches.enabled(watch.workspaceId).catch(() => false);
          enabled.set(watch.workspaceId, on);
        }
        if (!on) {
          // Switched off for this workspace: not read, and asked about again
          // in an hour rather than holding the front of the queue.
          await this.reschedule(watch, nextCheckAfterRead(this.clock(), this.random));
          continue;
        }

        let outcome: CheckOutcome;
        try {
          outcome = await this.check(watch, pace);
        } catch (error) {
          this.logger.warn({ watchId: watch.id, err: error }, "a channel automation check failed");
          await this.reschedule(
            watch,
            nextCheckAfterFailure(this.clock(), watch.checkFailures + 1, this.random),
          ).catch(() => undefined);
          continue;
        }
        switch (outcome.kind) {
          case "read":
            report.read += 1;
            report.recorded += outcome.recorded;
            report.started += outcome.started;
            break;
          case "paused":
            report.paused += 1;
            break;
          case "failed":
            report.read += 1;
            report.failedReads += 1;
            break;
          case "busy":
            report.busy = true;
            break;
          case "gone":
            break;
        }
        if (report.busy) break;
      }
    } finally {
      this.running = false;
    }
    return report;
  }

  /** Read one watch's feed, record what is new, start what is pending. */
  private async check(watch: SourceWatch, pace: () => Promise<void>): Promise<CheckOutcome> {
    if (!(await this.watches.canStartAs(watch.workspaceId, watch.createdBy))) {
      await this.pauseFor(watch, "creator_left");
      return { kind: "paused", reason: "creator_left" };
    }
    // A rule added to the start form since the watch was saved applies to it too.
    const setup = watchSetupSchema.safeParse(watch.setup);
    if (!setup.success) {
      await this.pauseFor(watch, "setup_invalid");
      return { kind: "paused", reason: "setup_invalid" };
    }

    await pace();
    let feed;
    try {
      feed = await this.directory.uploads(watch.channelId);
    } catch (error) {
      if (!(error instanceof ChannelLookupError)) throw error;
      // The gate is shut or YouTube just refused: nothing about this watch is
      // wrong, and it stays due for the next tick.
      if (error.code === "busy") return { kind: "busy" };
      await this.readFailed(watch, error.code);
      return { kind: "failed", code: error.code };
    }

    const now = this.clock();
    const recorded = await this.prisma.sourceWatchVideo.findMany({
      where: { watchId: watch.id, videoId: { in: feed.entries.map((entry) => entry.videoId) } },
      select: { videoId: true },
    });
    const plan = planFeed({
      now,
      since: watch.createdAt,
      firstRead: watch.cursor === null,
      backfill: watch.backfillCount,
      seen: seenOf(watch.cursor),
      recorded: new Set(recorded.map((row) => row.videoId)),
      entries: feed.entries,
    });
    if (plan.videos.length > 0) {
      await this.prisma.sourceWatchVideo.createMany({
        data: plan.videos.map((video) => ({
          id: ulid(),
          watchId: watch.id,
          videoId: video.videoId,
          title: video.title,
          publishedAt: video.publishedAt,
          state: video.state,
          reason: video.reason,
          backfill: video.backfill,
        })),
        // A second poll that read the same feed at the same moment: its rows are the same rows.
        skipDuplicates: true,
      });
    }

    const read = await this.prisma.sourceWatch.updateMany({
      // Paused or removed while its feed was being read: its rows stand, it starts nothing.
      where: { id: watch.id, state: "active" },
      data: {
        cursor: { seen: [...plan.seen] },
        lastCheckedAt: now,
        nextCheckAt: nextCheckAfterRead(now, this.random),
        checkFailures: 0,
        lastErrorCode: null,
        ...(feed.title !== null && feed.title !== watch.title ? { title: feed.title } : {}),
      },
    });
    if (read.count === 0) return { kind: "gone" };

    const started = await this.startPending(watch, setup.data);
    return { kind: "read", recorded: plan.videos.length, started };
  }

  /** Start up to {@link WATCH_STARTS_PER_CHECK} of the watch's pending uploads, oldest first. */
  private async startPending(watch: SourceWatch, setup: WatchSetup): Promise<number> {
    await this.recoverClaims(watch);
    const pending = await this.prisma.sourceWatchVideo.findMany({
      where: { watchId: watch.id, state: "pending" },
      orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
      take: WATCH_STARTS_PER_CHECK,
    });
    let started = 0;
    for (const video of pending) {
      const outcome = await this.start(watch, setup, video);
      if (outcome === "started") started += 1;
      if (outcome === "stop") break;
    }
    return started;
  }

  /**
   * Claims older than {@link WATCH_CLAIM_STALE_MS}, left by a poll that died
   * between claiming a video and filing its run: filed against the run it made,
   * when there is one, else `pending` again.
   */
  private async recoverClaims(watch: SourceWatch): Promise<void> {
    const cutoff = new Date(this.clock().getTime() - WATCH_CLAIM_STALE_MS);
    const stale = await this.prisma.sourceWatchVideo.findMany({
      where: {
        watchId: watch.id,
        state: "starting",
        OR: [{ claimedAt: { lt: cutoff } }, { claimedAt: null }],
      },
    });
    for (const video of stale) {
      const claimedAt = (video.claimedAt ?? video.updatedAt).getTime();
      const run = await this.prisma.repurposeRun.findFirst({
        where: {
          workspaceId: watch.workspaceId,
          sourceFingerprint: `youtube:${video.videoId}`,
          createdAt: { gte: new Date(claimedAt - 60_000) },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      await this.prisma.sourceWatchVideo.updateMany({
        where: { id: video.id, state: "starting" },
        data:
          run === null
            ? { state: "pending", claimedAt: null }
            : { state: "started", runId: run.id, reason: null },
      });
      this.logger.warn(
        { watchId: watch.id, videoId: video.videoId, runId: run?.id ?? null },
        "resolved a channel automation claim a poll left behind",
      );
    }
  }

  private async start(
    watch: SourceWatch,
    setup: WatchSetup,
    video: SourceWatchVideo,
  ): Promise<StartOutcome> {
    const claim = await this.prisma.sourceWatchVideo.updateMany({
      where: { id: video.id, state: "pending" },
      data: { state: "starting", claimedAt: this.clock() },
    });
    if (claim.count !== 1) return "lost";

    // Exactly the request the start form sends for a link, parsed by the same
    // schema, so its defaults apply and anything it refuses is refused here.
    const title = cleanTitle(video.title, RUN_TITLE_MAX);
    const request = createRunSchema.safeParse({
      source: {
        kind: "url",
        url: `https://www.youtube.com/watch?v=${video.videoId}`,
        rightsAttested: true,
      },
      setup: { ...setup, automation: "auto" },
      ...(title === "" ? {} : { title }),
    });
    if (!request.success) {
      await this.release(video);
      await this.pauseFor(watch, "setup_invalid");
      return "stop";
    }

    let runId: string;
    try {
      const created = await this.runs.create(watch.workspaceId, watch.createdBy, request.data, {
        attestation: {
          at: watch.rightsAttestedAt,
          by: watch.rightsAttestedBy,
          of: `watch:${watch.id}`,
        },
      });
      runId = created.run.id;
    } catch (error) {
      return this.startFailed(watch, video, error);
    }

    // The run exists. Filing it is what makes the claim final; if this write is
    // lost the claim goes stale and the next check files it (`recoverClaims`).
    try {
      await this.prisma.sourceWatchVideo.update({
        where: { id: video.id },
        data: { state: "started", runId, reason: null },
      });
    } catch (error) {
      this.logger.warn(
        { watchId: watch.id, videoId: video.videoId, runId, err: error },
        "a watch's run was started but not filed; the next check files it",
      );
    }
    await this.audit.record({
      action: "repurpose.watch.run_started",
      resource: "source_watch",
      resourceId: watch.id,
      actorId: watch.createdBy,
      actorKind: "system",
      workspaceId: watch.workspaceId,
      data: { videoId: video.videoId, runId, backfill: video.backfill },
    });
    await this.notices.newVideo(watch, { title: video.title, runId });
    return "started";
  }

  /** What a refused start means for the video and the watch. */
  private async startFailed(
    watch: SourceWatch,
    video: SourceWatchVideo,
    error: unknown,
  ): Promise<StartOutcome> {
    if (error instanceof AppException) {
      switch (error.code) {
        case REPURPOSE_ERRORS.sourceDuplicate: {
          // A run of this video is already live (started by hand, or by a
          // start this row lost track of): that run is this video's.
          const existing = (error.details as { existingRunId?: unknown } | undefined)
            ?.existingRunId;
          if (typeof existing === "string") {
            await this.prisma.sourceWatchVideo.updateMany({
              where: { id: video.id, state: "starting" },
              data: { state: "started", runId: existing, reason: "already_running" },
            });
            return "linked";
          }
          break;
        }
        case REPURPOSE_ERRORS.noCredits:
          await this.release(video);
          await this.pauseFor(watch, "no_credits");
          return "stop";
        case REPURPOSE_ERRORS.styleUnknown:
          await this.release(video);
          await this.pauseFor(watch, "style_unknown");
          return "stop";
        case REPURPOSE_ERRORS.disabled:
        case REPURPOSE_ERRORS.sourceUnsupported:
          // Switched off between the flag check and the start: try at the next check.
          await this.release(video);
          return "stop";
        default:
          break;
      }
      // A full plan lane, a queue that is down: not now, not never.
      if (isRefusal(error)) {
        await this.release(video);
        return "stop";
      }
      // Any other 4xx is about this video and will say the same next time.
      if (error.httpStatus < 500) {
        await this.prisma.sourceWatchVideo.updateMany({
          where: { id: video.id, state: "starting" },
          data: { state: "failed", reason: error.code, attempts: { increment: 1 } },
        });
        this.logger.log(
          { watchId: watch.id, videoId: video.videoId, code: error.code },
          "a channel automation could not start a video",
        );
        return "failed";
      }
    }

    const attempts = video.attempts + 1;
    const giveUp = attempts >= WATCH_START_ATTEMPTS;
    await this.prisma.sourceWatchVideo.updateMany({
      where: { id: video.id, state: "starting" },
      data: giveUp
        ? { state: "failed", reason: "start_failed", attempts, claimedAt: null }
        : { state: "pending", attempts, claimedAt: null },
    });
    this.logger.warn(
      { watchId: watch.id, videoId: video.videoId, attempts, err: error },
      giveUp
        ? "a channel automation gave up starting a video"
        : "a channel automation could not start a video; the next check tries again",
    );
    return "stop";
  }

  /** Back to `pending`: the video is started at a later check. */
  private async release(video: SourceWatchVideo): Promise<void> {
    await this.prisma.sourceWatchVideo.updateMany({
      where: { id: video.id, state: "starting" },
      data: { state: "pending", claimedAt: null },
    });
  }

  /** A feed read failed: back off, and after three "no such channel" in a row, say so. */
  private async readFailed(watch: SourceWatch, code: ChannelLookupErrorCode): Promise<void> {
    const failures = watch.checkFailures + 1;
    const errorCode = code === "not_found" ? "channel_not_found" : "channel_unreadable";
    await this.prisma.sourceWatch.updateMany({
      where: { id: watch.id, state: "active" },
      data: {
        checkFailures: failures,
        lastErrorCode: errorCode,
        nextCheckAt: nextCheckAfterFailure(this.clock(), failures, this.random),
      },
    });
    const gone =
      code === "not_found" &&
      failures >= WATCH_NOT_FOUND_LIMIT &&
      watch.lastErrorCode === "channel_not_found";
    if (gone) await this.pauseFor(watch, "channel_not_found");
  }

  /**
   * Pause (or, for a channel that has gone, fail) the watch. Only the poll that
   * moves it out of `active` writes the audit entry and sends the notice, so a
   * person hears about each pause once.
   */
  private async pauseFor(watch: SourceWatch, reason: WatchStateReason): Promise<void> {
    const at = this.clock();
    const moved = await this.prisma.sourceWatch.updateMany({
      where: { id: watch.id, state: "active" },
      data: {
        state: reason === "channel_not_found" ? "error" : "paused",
        stateReason: reason,
        stateChangedAt: at,
      },
    });
    if (moved.count === 0) return;
    await this.audit.record({
      action: "repurpose.watch.paused",
      resource: "source_watch",
      resourceId: watch.id,
      actorKind: "system",
      workspaceId: watch.workspaceId,
      data: { reason },
    });
    await this.notices.paused(watch, reason, at);
  }

  private async reschedule(watch: SourceWatch, at: Date): Promise<void> {
    await this.prisma.sourceWatch.updateMany({
      where: { id: watch.id, state: "active" },
      data: { nextCheckAt: at },
    });
  }
}
