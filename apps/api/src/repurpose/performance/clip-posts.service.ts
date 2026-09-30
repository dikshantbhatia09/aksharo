import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import {
  countsOf,
  engagementRate,
  hasAnyCount,
  isMeasured,
  mergeLatest,
  readLatest,
} from "./metrics.js";
import {
  MAX_POSTS_PER_CLIP,
  PERFORMANCE_ERRORS,
  PERFORMANCE_FLAG,
  PERFORMANCE_REFRESH_TASK,
  READ_ERRORS,
} from "./performance.constants.js";
import {
  PLATFORM_LABELS,
  isPostPlatform,
  isRefusal,
  parsePostLink,
  postizPostKey,
} from "./post-links.js";
import { MAX_READ_FAILURES } from "./refresh-plan.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import {
  ASPECT_OF_SHAPE,
  REPURPOSE_ERRORS,
  REPURPOSE_FLAGS,
  SHAPE_OF_ASPECT,
} from "../repurpose.constants.js";
import { RepurposeService } from "../repurpose.service.js";

import type { Latest, LatestEntry, Metric } from "./metrics.js";
import type {
  AddPostInput,
  ClipPostView,
  EnterNumbersInput,
  MetricView,
  ReadingState,
  RunPerformanceView,
} from "./performance.dto.js";
import type { PostPlatform } from "./post-links.js";
import type { $Enums, ClipPost, Prisma } from "@prisma/client";

/**
 * Where a run's clips went, and how each post did (2026-10-05): the routes'
 * half of learning what works. The reading is `PerformanceRefresher`'s.
 *
 * What it holds to:
 *
 *   * **One row per post.** A post is one video on one platform - one shape of
 *     one clip, in its own words or a dub's. `(workspace, post_key)` is unique,
 *     `post_key` being the platform's own id for it, so a video pasted twice is
 *     refused the second time; a link pasted before Aksharo adopted the same
 *     post from Postiz becomes that post; and a link pasted for a Postiz post
 *     Postiz never said the link of becomes its link.
 *   * **Postiz posts arrive by themselves.** Every `publish_targets` row that
 *     went out is adopted (on this page's read, and by the refresh task), with
 *     Postiz's post id to read its analytics by. Such a post cannot be removed
 *     here: it is followed from Postiz.
 *   * **Numbers are never overwritten.** A person's numbers are a snapshot like
 *     any read, with their source and time; the page shows, per number, which
 *     was measured and which was entered, and when.
 *   * **Tenancy**: every lookup is by workspace and id together; a post is only
 *     ever found through its own run.
 */

/** A `clip_posts` row. */
type PostRow = ClipPost;

const SHAPES = Object.keys(ASPECT_OF_SHAPE) as (keyof typeof ASPECT_OF_SHAPE)[];

/** A date a person gives for when a post went out: not before this. */
const EARLIEST_POSTED_AT = Date.parse("2005-01-01T00:00:00Z");
/** Nor later than now plus this (their clock, a time zone ahead). */
const POSTED_AT_SLACK_MS = 24 * 60 * 60_000;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Whether Aksharo reads a post's numbers by itself: Postiz's analytics for a
 * post made through it (not a personal LinkedIn profile's, which LinkedIn does
 * not share), and the watch page for a YouTube link.
 */
export function readsItself(
  source: $Enums.ClipPostSource,
  platform: string,
  settings: Prisma.JsonValue | null,
): boolean {
  if (source === "link") return platform === "youtube";
  if (platform !== "linkedin") return true;
  const surface =
    typeof settings === "object" && settings !== null && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)["surface"]
      : undefined;
  return surface === "organization";
}

const STOPPED_NOTES: Readonly<Record<string, string>> = Object.freeze({
  [READ_ERRORS.empty]: "No numbers came back for this post, so reading it stopped.",
  [READ_ERRORS.unreadable]: "Its numbers could not be read, so reading it stopped.",
  [READ_ERRORS.failed]: "Reading its numbers kept failing, so it stopped.",
  [READ_ERRORS.unavailable]:
    "The video is private, removed or not out yet, so its numbers cannot be read.",
  [READ_ERRORS.missing]:
    "The post is gone from where it was scheduled, so its numbers cannot be read.",
});

function metricView(entry: LatestEntry | undefined): MetricView | null {
  if (entry === undefined) return null;
  return {
    value: entry.value,
    source: entry.source,
    measured: isMeasured(entry.source),
    at: entry.at,
  };
}

/** How the page describes the post's reading. */
function readingOf(
  post: PostRow,
  readable: boolean,
): { state: ReadingState; nextAt: string | null; note: string | null } {
  const label = isPostPlatform(post.platform) ? PLATFORM_LABELS[post.platform] : post.platform;
  if (!readable) {
    return {
      state: "manual",
      nextAt: null,
      note:
        post.source === "postiz"
          ? `${label} does not share numbers for personal posts: type them in when you check.`
          : `Aksharo cannot read ${label} numbers by itself: type them in when you check.`,
    };
  }
  if (post.nextReadAt !== null) {
    return { state: "reading", nextAt: post.nextReadAt.toISOString(), note: null };
  }
  if (post.readFailures >= MAX_READ_FAILURES || (post.reads === 0 && post.lastReadError !== null)) {
    const code = post.lastReadError ?? READ_ERRORS.failed;
    return {
      state: "stopped",
      nextAt: null,
      note: Object.hasOwn(STOPPED_NOTES, code)
        ? // eslint-disable-next-line security/detect-object-injection -- checked just above
          (STOPPED_NOTES[code] ?? null)
        : null,
    };
  }
  return { state: "done", nextAt: null, note: "Its first month is read." };
}

@Injectable()
export class ClipPostsService {
  private readonly logger = new Logger(ClipPostsService.name);

  /** A field so a test can set the clock. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RepurposeService,
    private readonly audit: CommonAuditService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  // -------------------------------------------------------------------------
  // Flags
  // -------------------------------------------------------------------------

  /** `repurpose_flow` and `repurpose_performance` are both on for the workspace. */
  async enabled(workspaceId: string): Promise<boolean> {
    for (const flag of [REPURPOSE_FLAGS.flow, PERFORMANCE_FLAG]) {
      if (!(await this.runs.flagEnabled(workspaceId, flag))) return false;
    }
    return true;
  }

  /** 404 while the surface is off, like every clips route: it does not advertise itself. */
  async assertEnabled(workspaceId: string): Promise<void> {
    if (await this.enabled(workspaceId)) return;
    throw disabled();
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  /**
   * A run's posts, per clip, and what each clip can say was posted. 404 while
   * the clips pipeline is off; `enabled: false` and nothing else while only
   * this feature is, so the run page shows no panel rather than an error.
   */
  async runPerformance(workspaceId: string, runId: string): Promise<RunPerformanceView> {
    if (!(await this.runs.flagEnabled(workspaceId, REPURPOSE_FLAGS.flow))) throw disabled();
    await this.requireRun(workspaceId, runId);
    if (!(await this.runs.flagEnabled(workspaceId, PERFORMANCE_FLAG))) {
      return { runId, enabled: false, readsEnabled: false, posts: [], clips: [] };
    }
    // What went out through Postiz since the last look is here the moment the page asks.
    await this.adoptPublished({ workspaceId, clip: { runId } }).catch((error: unknown) => {
      this.logger.warn(
        { runId, err: error },
        "could not adopt a run's Postiz posts; showing the rest",
      );
    });

    const [posts, clips, dubs] = await Promise.all([
      this.prisma.clipPost.findMany({
        where: { workspaceId, runId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: { publishTarget: { select: { settings: true } } },
      }),
      this.prisma.repurposeClip.findMany({
        where: { runId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, variants: { select: { aspect: true } } },
      }),
      this.prisma.clipDub.findMany({
        where: { runId, workspaceId },
        select: { clipId: true, variants: { select: { language: true } } },
      }),
    ]);

    const languages = new Map<string, Set<string>>();
    for (const dub of dubs) {
      const held = languages.get(dub.clipId) ?? new Set<string>();
      for (const variant of dub.variants) held.add(variant.language);
      languages.set(dub.clipId, held);
    }
    return {
      runId,
      enabled: true,
      readsEnabled: this.scheduler.scheduled.includes(PERFORMANCE_REFRESH_TASK),
      posts: posts.map((post) => this.view(post, post.publishTarget?.settings ?? null)),
      clips: clips.map((clip) => ({
        clipId: clip.id,
        shapes: shapesOf(clip.variants),
        languages: [...(languages.get(clip.id) ?? [])].sort(),
      })),
    };
  }

  /** "I posted this": a link to a post of one of the clip's shapes. */
  async addLink(
    workspaceId: string,
    userId: string,
    runId: string,
    clipId: string,
    input: AddPostInput,
  ): Promise<ClipPostView> {
    await this.assertEnabled(workspaceId);
    await this.requireRun(workspaceId, runId);
    const clip = await this.prisma.repurposeClip.findFirst({
      where: { id: clipId, runId },
      select: {
        id: true,
        variants: { select: { aspect: true } },
        dubs: { select: { variants: { select: { language: true } } } },
      },
    });
    if (clip === null) {
      throw new AppException(
        PERFORMANCE_ERRORS.clipNotFound,
        "We could not find that clip.",
        HttpStatus.NOT_FOUND,
      );
    }

    const link = parsePostLink(input.url);
    if (isRefusal(link)) throw new AppException(link.refused, link.message, HttpStatus.BAD_REQUEST);

    const shape = input.shape ?? "9:16";
    if (!shapesOf(clip.variants).includes(shape)) {
      throw new AppException(
        PERFORMANCE_ERRORS.shapeUnknown,
        `This clip was not made in ${shape}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const language = input.language ?? null;
    if (
      language !== null &&
      !clip.dubs.some((dub) => dub.variants.some((variant) => variant.language === language))
    ) {
      throw new AppException(
        PERFORMANCE_ERRORS.languageUnknown,
        "This clip has no dubbed version in that language.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const now = this.now();
    const postedAt = this.postedAtOf(input.postedAt, now);

    const count = await this.prisma.clipPost.count({ where: { clipId } });
    if (count >= MAX_POSTS_PER_CLIP) {
      throw new AppException(
        PERFORMANCE_ERRORS.tooManyPosts,
        `A clip can carry ${String(MAX_POSTS_PER_CLIP)} posts. Remove one you no longer follow first.`,
        HttpStatus.CONFLICT,
      );
    }

    // eslint-disable-next-line security/detect-object-injection -- a shape from the closed enum
    const aspect = ASPECT_OF_SHAPE[shape];
    let post: PostRow;
    let linked = false;
    try {
      // The clip's post of this platform and shape made from Aksharo, whose
      // link the posting service never said: the link pasted is its link, not
      // a second post of the same video (its numbers are still read by id).
      const unlinked =
        language === null
          ? await this.prisma.clipPost.findFirst({
              where: {
                workspaceId,
                clipId,
                platform: link.platform,
                aspect,
                language: null,
                source: "postiz",
                url: null,
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            })
          : null;
      if (unlinked !== null) {
        post = await this.prisma.clipPost.update({
          where: { id: unlinked.id },
          data: { postKey: link.key, url: link.url },
        });
        linked = true;
      } else {
        post = await this.prisma.clipPost.create({
          data: {
            id: ulid(),
            workspaceId,
            runId,
            clipId,
            aspect,
            language,
            platform: link.platform,
            source: "link",
            postKey: link.key,
            url: link.url,
            postedAt,
            // A day alone (`2026-10-04`) says nothing about the hour.
            postedTimeKnown: postedAt !== null && (input.postedAt?.length ?? 0) > 10,
            nextReadAt: readsItself("link", link.platform, null) ? now : null,
            createdBy: userId,
          },
        });
      }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.clipPost.findUnique({
        where: { workspaceId_postKey: { workspaceId, postKey: link.key } },
        select: { id: true, clipId: true },
      });
      throw new AppException(
        PERFORMANCE_ERRORS.postExists,
        existing?.clipId === clipId
          ? "This post is already on this clip."
          : "This post is already recorded, on another clip.",
        HttpStatus.CONFLICT,
        existing === null ? undefined : { postId: existing.id, clipId: existing.clipId },
      );
    }

    await this.audit.record({
      action: linked ? "repurpose.performance.post_linked" : "repurpose.performance.post_added",
      resource: "clip_post",
      resourceId: post.id,
      actorId: userId,
      workspaceId,
      data: { runId, clipId, platform: link.platform, shape, language },
    });
    return this.view(post, null);
  }

  /** Stop following a pasted link. Its numbers go with it. */
  async removePost(
    workspaceId: string,
    userId: string,
    runId: string,
    postId: string,
  ): Promise<{ readonly removed: true }> {
    await this.assertEnabled(workspaceId);
    const post = await this.requirePost(workspaceId, runId, postId);
    if (post.source === "postiz") {
      throw new AppException(
        PERFORMANCE_ERRORS.postNotRemovable,
        "A post made through Aksharo is followed from where it was posted. Delete it there to stop following it.",
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.clipPost.deleteMany({ where: { id: post.id, workspaceId } });
    await this.audit.record({
      action: "repurpose.performance.post_removed",
      resource: "clip_post",
      resourceId: post.id,
      actorId: userId,
      workspaceId,
      data: { runId, clipId: post.clipId, platform: post.platform },
    });
    return { removed: true };
  }

  /** Numbers a person read off the platform's app, kept as entered. */
  async enterNumbers(
    workspaceId: string,
    userId: string,
    runId: string,
    postId: string,
    input: EnterNumbersInput,
  ): Promise<ClipPostView> {
    await this.assertEnabled(workspaceId);
    if (!hasAnyCount(input)) {
      throw new AppException(
        PERFORMANCE_ERRORS.numbersEmpty,
        "Type at least one number: views, likes, comments or shares.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const post = await this.requirePost(workspaceId, runId, postId);
    const now = this.now();
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.clipPostSnapshot.create({
        data: {
          id: ulid(),
          postId: post.id,
          workspaceId,
          source: "person",
          views: input.views ?? null,
          likes: input.likes ?? null,
          comments: input.comments ?? null,
          shares: input.shares ?? null,
          readAt: now,
          enteredBy: userId,
        },
      });
      const current = await tx.clipPost.findUniqueOrThrow({
        where: { id: post.id },
        select: { latest: true },
      });
      return tx.clipPost.update({
        where: { id: post.id },
        data: { latest: mergeLatest(readLatest(current.latest), input, "person", now) },
        include: { publishTarget: { select: { settings: true } } },
      });
    });
    await this.audit.record({
      action: "repurpose.performance.numbers_entered",
      resource: "clip_post",
      resourceId: post.id,
      actorId: userId,
      workspaceId,
      data: {
        runId,
        clipId: post.clipId,
        ...Object.fromEntries(
          (["views", "likes", "comments", "shares"] as const)
            // eslint-disable-next-line security/detect-object-injection -- a metric from the closed list
            .filter((metric) => input[metric] !== undefined)
            // eslint-disable-next-line security/detect-object-injection -- as above
            .map((metric) => [metric, input[metric] ?? null]),
        ),
      },
    });
    return this.view(updated, updated.publishTarget?.settings ?? null);
  }

  // -------------------------------------------------------------------------
  // Postiz posts
  // -------------------------------------------------------------------------

  /**
   * File every Postiz post that went out and has no row yet: a post the
   * dispatcher settled as `published` is Postiz's, with the id its analytics
   * are read by. A link pasted before for the same video becomes this post
   * (its numbers kept). `enabled` leaves out workspaces with the feature off.
   *
   * @returns how many posts were filed.
   */
  async adoptPublished(
    scope: Prisma.PublishTargetWhereInput,
    options: {
      readonly limit?: number;
      readonly enabled?: (workspaceId: string) => Promise<boolean>;
    } = {},
  ): Promise<number> {
    const targets = await this.prisma.publishTarget.findMany({
      where: {
        ...scope,
        status: "published",
        externalPostId: { not: null },
        clipPost: { is: null },
      },
      orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
      take: options.limit ?? 200,
      select: {
        id: true,
        workspaceId: true,
        clipId: true,
        provider: true,
        externalPostId: true,
        externalUrl: true,
        publishedAt: true,
        settings: true,
        clip: { select: { runId: true } },
        variant: { select: { aspect: true } },
      },
    });
    const allowed = new Map<string, boolean>();
    let adopted = 0;
    for (const target of targets) {
      if (!isPostPlatform(target.provider) || target.externalPostId === null) continue;
      if (options.enabled !== undefined) {
        let on = allowed.get(target.workspaceId);
        if (on === undefined) {
          on = await options.enabled(target.workspaceId).catch(() => false);
          allowed.set(target.workspaceId, on);
        }
        if (!on) continue;
      }
      const platform: PostPlatform = target.provider;
      const { key, url } = postizPostKey(platform, target.externalUrl, target.externalPostId);
      const now = this.now();
      const readable = readsItself("postiz", platform, target.settings);
      const data = {
        runId: target.clip.runId,
        clipId: target.clipId,
        aspect: target.variant.aspect,
        platform,
        source: "postiz" as const,
        publishTargetId: target.id,
        externalPostId: target.externalPostId,
        postedAt: target.publishedAt,
        postedTimeKnown: target.publishedAt !== null,
        nextReadAt: readable ? now : null,
      };
      try {
        await this.prisma.clipPost.create({
          data: { id: ulid(), workspaceId: target.workspaceId, postKey: key, url, ...data },
        });
        adopted += 1;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The same video pasted as a link first: it becomes this post. Anything
        // else (another pass adopting it at the same moment) is already filed.
        try {
          const moved = await this.prisma.clipPost.updateMany({
            where: {
              workspaceId: target.workspaceId,
              postKey: key,
              source: "link",
              publishTargetId: null,
            },
            data: {
              ...data,
              language: null,
              readFailures: 0,
              lastReadError: null,
              ...(url === null ? {} : { url }),
            },
          });
          adopted += moved.count;
        } catch (moveError) {
          if (!isUniqueViolation(moveError)) throw moveError;
        }
      }
    }
    return adopted;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  view(post: PostRow, settings: Prisma.JsonValue | null): ClipPostView {
    const latest: Latest = readLatest(post.latest);
    const platform: PostPlatform = isPostPlatform(post.platform) ? post.platform : "youtube";
    const numbers = {
      views: metricView(latest.views),
      likes: metricView(latest.likes),
      comments: metricView(latest.comments),
      shares: metricView(latest.shares),
    } satisfies Record<Metric, MetricView | null>;
    return {
      id: post.id,
      runId: post.runId,
      clipId: post.clipId,
      platform,
      // eslint-disable-next-line security/detect-object-injection -- a platform from the closed list
      platformLabel: PLATFORM_LABELS[platform],

      shape: SHAPE_OF_ASPECT[post.aspect],
      language: post.language,
      source: post.source,
      url: post.url,
      postedAt: post.postedAt?.toISOString() ?? null,
      numbers,
      engagementRate: engagementRate(countsOf(latest)),
      reading: readingOf(post, readsItself(post.source, post.platform, settings)),
      canRemove: post.source === "link",
      createdAt: post.createdAt.toISOString(),
    };
  }

  private postedAtOf(raw: string | undefined, now: Date): Date | null {
    if (raw === undefined) return null;
    const at = Date.parse(raw.length === 10 ? `${raw}T12:00:00Z` : raw);
    if (
      !Number.isFinite(at) ||
      at < EARLIEST_POSTED_AT ||
      at > now.getTime() + POSTED_AT_SLACK_MS
    ) {
      throw new AppException(
        PERFORMANCE_ERRORS.dateInvalid,
        "That date is in the future. Give the day it went out.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return new Date(at);
  }

  private async requireRun(workspaceId: string, runId: string): Promise<void> {
    const run = await this.prisma.repurposeRun.findFirst({
      where: { id: runId, workspaceId },
      select: { id: true },
    });
    if (run === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that video project.",
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async requirePost(workspaceId: string, runId: string, postId: string): Promise<PostRow> {
    const post = await this.prisma.clipPost.findFirst({
      where: { id: postId, workspaceId, runId },
    });
    if (post === null) {
      throw new AppException(
        PERFORMANCE_ERRORS.postNotFound,
        "We could not find that post.",
        HttpStatus.NOT_FOUND,
      );
    }
    return post;
  }
}

function disabled(): AppException {
  return new AppException(
    PERFORMANCE_ERRORS.disabled,
    "This feature is not available yet.",
    HttpStatus.NOT_FOUND,
  );
}

/** The shapes a clip was made in, as `9:16`, in the shapes' own order; 9:16 for a clip with none yet. */
function shapesOf(variants: readonly { readonly aspect: $Enums.Aspect }[]): string[] {
  const made = new Set(variants.map((variant) => SHAPE_OF_ASPECT[variant.aspect]));
  const shapes = SHAPES.filter((shape) => made.has(shape));
  return shapes.length === 0 ? ["9:16"] : shapes;
}
