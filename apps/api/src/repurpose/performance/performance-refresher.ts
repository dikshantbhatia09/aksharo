import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";

import { ClipPostsService } from "./clip-posts.service.js";
import { hasAnyCount, mergeLatest, readLatest } from "./metrics.js";
import {
  ADOPT_BATCH,
  DUE_BATCH,
  FLAG_OFF_RECHECK_MS,
  PERFORMANCE_REFRESH_TASK,
  PERFORMANCE_REFRESH_TICK_MS,
  POSTIZ_DEFAULT_PAUSE_MS,
  POSTIZ_READS_PER_TICK,
  READ_ERRORS,
  YOUTUBE_READS_PER_TICK,
  YOUTUBE_READ_SPACING_MS,
} from "./performance.constants.js";
import { parsePostizAnalytics } from "./postiz-analytics.js";
import { ReadBudget } from "./read-budget.js";
import { analyticsDays, nextReadAfter, nextReadAfterFailure } from "./refresh-plan.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { isPostizError } from "../../publishing/postiz/postiz.errors.js";

import type { Counts, MetricSource } from "./metrics.js";
import type { ViewReader } from "./youtube-views.js";
import type { ClipPost, Prisma } from "@prisma/client";

/** What of Postiz the refresher uses: its per-post analytics. The seam tests replace. */
export interface PostizAnalyticsSource {
  readonly configured: boolean;
  postAnalytics(postId: string, days: number): Promise<unknown>;
}

/** Injection tokens for the two readers. */
export const POSTIZ_ANALYTICS = Symbol("POSTIZ_ANALYTICS");
export const VIEW_READER = Symbol("VIEW_READER");
/** The Postiz allowance, built from `PERFORMANCE_POSTIZ_READS_PER_HOUR` at boot. */
export const POSTIZ_READ_BUDGET = Symbol("POSTIZ_READ_BUDGET");

export interface RefreshReport {
  /** Postiz posts that went out, filed this tick. */
  readonly adopted: number;
  readonly postizReads: number;
  readonly youtubeReads: number;
  /** Reads that found numbers. */
  readonly recorded: number;
  /** Reads that failed or found nothing. */
  readonly failed: number;
  /** Postiz's allowance is spent or paused: its reads wait. */
  readonly postizWaiting: boolean;
  /** YouTube is refusing (or the gate is not closed): its reads wait. */
  readonly youtubeBusy: boolean;
  /** Another tick was still running: this one did nothing. */
  readonly overlapped: boolean;
}

type Outcome = "recorded" | "failed" | "wait";

/**
 * How the clips' posts did, read on a schedule (2026-10-05): the
 * `repurpose.performance-refresh` task, every ten minutes.
 *
 * Each tick files the Postiz posts that went out since the last one, then reads
 * the posts that are due - oldest-read first, so when more is due than the
 * budgets allow everything still gets its turn - and schedules each one's next
 * read (`refresh-plan.ts`): often while it is new, never after its month.
 *
 *   * **Postiz** - at most one read a tick, within an hourly allowance
 *     (`PERFORMANCE_POSTIZ_READS_PER_HOUR`, 6 by default, 10 at most) of the
 *     30 requests an hour the key allows posting and reading together. Never
 *     retried; a 429 pauses every read for as long as Postiz asks.
 *   * **YouTube** - the public watch page of a pasted YouTube link, two a tick,
 *     seconds apart, through `SourceGate`: nothing while it is open or
 *     half-open, and a refusal trips it for every YouTube request.
 *   * Other platforms' links are never read: their numbers are typed in.
 *
 * **Inert until switched on.** Production runs only the tasks named in
 * `MONTAJ_SCHEDULER_TASKS`; this one runs nowhere until the operator adds
 * `repurpose.performance-refresh` there. Per workspace, only while
 * `repurpose_performance` and `repurpose_flow` are on: a workspace's posts are
 * otherwise left alone and asked about again a day later.
 */
@Injectable()
export class PerformanceRefresher implements OnModuleInit {
  private readonly logger = new Logger(PerformanceRefresher.name);
  private running = false;

  /** Test seams: the clock and the pause between page reads. */
  clock: () => Date = () => new Date();
  sleep: (ms: number) => Promise<void> = async (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: ClipPostsService,
    private readonly scheduler: ScheduledTasksService,
    @Inject(POSTIZ_ANALYTICS) private readonly postiz: PostizAnalyticsSource,
    @Inject(VIEW_READER) private readonly views: ViewReader,
    @Inject(POSTIZ_READ_BUDGET) private readonly budget: ReadBudget,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: PERFORMANCE_REFRESH_TASK,
      everyMs: PERFORMANCE_REFRESH_TICK_MS,
      run: async () => {
        const report = await this.tick();
        if (report.adopted + report.postizReads + report.youtubeReads > 0 || report.youtubeBusy) {
          this.logger.log(report, "clip performance read");
        }
      },
    });
  }

  /** One pass: adopt, then read what is due. Never throws for one post's trouble. */
  async tick(): Promise<RefreshReport> {
    const report = {
      adopted: 0,
      postizReads: 0,
      youtubeReads: 0,
      recorded: 0,
      failed: 0,
      postizWaiting: false,
      youtubeBusy: false,
      overlapped: false,
    };
    if (this.running) return { ...report, overlapped: true };
    this.running = true;
    try {
      const enabled = new Map<string, boolean>();
      const isEnabled = async (workspaceId: string): Promise<boolean> => {
        let on = enabled.get(workspaceId);
        if (on === undefined) {
          on = await this.posts.enabled(workspaceId).catch(() => false);
          enabled.set(workspaceId, on);
        }
        return on;
      };

      report.adopted = await this.posts
        .adoptPublished({}, { limit: ADOPT_BATCH, enabled: isEnabled })
        .catch((error: unknown) => {
          this.logger.warn({ err: error }, "could not adopt published Postiz posts");
          return 0;
        });

      // Postiz: one read a tick, within the hour's allowance.
      if (this.postiz.configured) {
        const due = await this.due({ source: "postiz", externalPostId: { not: null } }, isEnabled);
        for (const post of due.slice(0, POSTIZ_READS_PER_TICK)) {
          if (!this.budget.take()) {
            report.postizWaiting = true;
            break;
          }
          report.postizReads += 1;
          const outcome = await this.readPostiz(post).catch((error: unknown) => {
            this.logger.warn({ postId: post.id, err: error }, "a Postiz analytics read failed");
            return "failed" as const;
          });
          if (outcome === "wait") {
            report.postizWaiting = true;
            break;
          }
          if (outcome === "recorded") report.recorded += 1;
          else report.failed += 1;
        }
      }

      // YouTube: a few watch pages, seconds apart, and none while it refuses.
      const due = await this.due({ source: "link", platform: "youtube" }, isEnabled);
      for (const [index, post] of due.slice(0, YOUTUBE_READS_PER_TICK).entries()) {
        if (index > 0) await this.sleep(YOUTUBE_READ_SPACING_MS);
        const outcome = await this.readYouTube(post).catch((error: unknown) => {
          this.logger.warn({ postId: post.id, err: error }, "a YouTube view count read failed");
          return "failed" as const;
        });
        if (outcome === "wait") {
          report.youtubeBusy = true;
          break;
        }
        report.youtubeReads += 1;
        if (outcome === "recorded") report.recorded += 1;
        else report.failed += 1;
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  /**
   * Posts of one source that are due, oldest-read first, in workspaces with the
   * feature on. A post of a workspace with it off is asked about a day later
   * rather than holding the front of the queue.
   */
  private async due(
    where: Prisma.ClipPostWhereInput,
    isEnabled: (workspaceId: string) => Promise<boolean>,
  ): Promise<ClipPost[]> {
    const now = this.clock();
    const rows = await this.prisma.clipPost.findMany({
      where: { ...where, nextReadAt: { lte: now } },
      orderBy: [
        { lastReadAt: { sort: "asc", nulls: "first" } },
        { nextReadAt: "asc" },
        { id: "asc" },
      ],
      take: DUE_BATCH,
    });
    const ready: ClipPost[] = [];
    for (const row of rows) {
      if (await isEnabled(row.workspaceId)) {
        ready.push(row);
        continue;
      }
      // By id alone: a time set by hand in SQL carries microseconds, which an
      // equality on the value Prisma read (milliseconds) would never match.
      await this.prisma.clipPost.updateMany({
        where: { id: row.id },
        data: { nextReadAt: new Date(now.getTime() + FLAG_OFF_RECHECK_MS) },
      });
    }
    return ready;
  }

  private async readPostiz(post: ClipPost): Promise<Outcome> {
    const now = this.clock();
    if (post.externalPostId === null) return this.recordFailure(post, READ_ERRORS.missing, now);
    const anchor = post.postedAt ?? post.createdAt;
    let body: unknown;
    try {
      body = await this.postiz.postAnalytics(post.externalPostId, analyticsDays(anchor, now));
    } catch (error) {
      if (!isPostizError(error)) return this.recordFailure(post, READ_ERRORS.failed, now);
      switch (error.kind) {
        case "rate_limited":
          // Postiz's own limit: every read waits as long as it asks; the post
          // stays due, and nothing is held against it.
          this.budget.pauseUntil(now.getTime() + (error.retryAfterMs ?? POSTIZ_DEFAULT_PAUSE_MS));
          return "wait";
        case "not_configured":
        case "unauthorized":
        case "forbidden":
          // The key, not the post: wait an hour rather than fail every post.
          this.budget.pauseUntil(now.getTime() + POSTIZ_DEFAULT_PAUSE_MS);
          return "wait";
        case "unreachable":
          // Postiz is down and nothing was sent: the post keeps its place.
          return "wait";
        case "not_found":
          return this.recordFailure(post, READ_ERRORS.missing, now);
        case "malformed":
          return this.recordFailure(post, READ_ERRORS.unreadable, now);
        default:
          return this.recordFailure(post, READ_ERRORS.failed, now);
      }
    }
    const analytics = parsePostizAnalytics(body);
    if (analytics === null) return this.recordFailure(post, READ_ERRORS.unreadable, now);
    if (!hasAnyCount(analytics.counts)) return this.recordFailure(post, READ_ERRORS.empty, now);
    return this.recordRead(post, analytics.counts, "postiz", now, {
      extra: Object.keys(analytics.extra).length === 0 ? null : analytics.extra,
    });
  }

  private async readYouTube(post: ClipPost): Promise<Outcome> {
    const now = this.clock();
    const videoId = post.postKey.startsWith("youtube:")
      ? post.postKey.slice("youtube:".length)
      : "";
    const read = await this.views.read(videoId);
    switch (read.kind) {
      case "views":
        return this.recordRead(post, { views: read.views }, "youtube_page", now, {
          postedAt: read.publishedAt,
        });
      case "busy":
      case "blocked":
        return "wait";
      case "unavailable":
        return this.recordFailure(post, READ_ERRORS.unavailable, now);
      case "unreadable":
        return this.recordFailure(post, READ_ERRORS.unreadable, now);
      case "failed":
        return this.recordFailure(post, READ_ERRORS.failed, now);
    }
  }

  /** A read that found numbers: a snapshot, the cache, and the next read. */
  private async recordRead(
    post: ClipPost,
    counts: Counts,
    source: MetricSource,
    now: Date,
    more: { readonly extra?: Record<string, number> | null; readonly postedAt?: Date | null } = {},
  ): Promise<Outcome> {
    // A time the platform says, when nobody said one: the page's publish date.
    const postedAt =
      post.postedAt === null && more.postedAt !== undefined && more.postedAt !== null
        ? more.postedAt
        : null;
    const anchor = post.postedAt ?? postedAt ?? post.createdAt;
    await this.prisma.$transaction(async (tx) => {
      await tx.clipPostSnapshot.create({
        data: {
          id: ulid(),
          postId: post.id,
          workspaceId: post.workspaceId,
          source,
          views: counts.views ?? null,
          likes: counts.likes ?? null,
          comments: counts.comments ?? null,
          shares: counts.shares ?? null,
          ...(more.extra === undefined || more.extra === null ? {} : { extra: more.extra }),
          readAt: now,
        },
      });
      const current = await tx.clipPost.findUnique({
        where: { id: post.id },
        select: { latest: true },
      });
      if (current === null) return;
      await tx.clipPost.update({
        where: { id: post.id },
        data: {
          latest: mergeLatest(readLatest(current.latest), counts, source, now),
          lastReadAt: now,
          reads: { increment: 1 },
          readFailures: 0,
          lastReadError: null,
          nextReadAt: nextReadAfter(anchor, now),
          ...(postedAt === null ? {} : { postedAt, postedTimeKnown: true }),
        },
      });
    });
    return "recorded";
  }

  /** A read that failed or found nothing: back off, and give up after a few in a row. */
  private async recordFailure(post: ClipPost, code: string, now: Date): Promise<Outcome> {
    const failures = post.readFailures + 1;
    await this.prisma.clipPost.updateMany({
      where: { id: post.id },
      data: {
        readFailures: failures,
        lastReadError: code,
        lastReadAt: now,
        nextReadAt: nextReadAfterFailure(post.postedAt ?? post.createdAt, now, failures),
      },
    });
    return "failed";
  }
}
