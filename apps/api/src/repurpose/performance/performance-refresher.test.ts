import { describe, expect, it, vi } from "vitest";

import { readLatest } from "./metrics.js";
import { PerformanceRefresher } from "./performance-refresher.js";
import {
  PERFORMANCE_REFRESH_TASK,
  POSTIZ_DEFAULT_PAUSE_MS,
  READ_ERRORS,
  YOUTUBE_READ_SPACING_MS,
} from "./performance.constants.js";
import { ReadBudget } from "./read-budget.js";
import { MAX_READ_FAILURES } from "./refresh-plan.js";
import { PostizError } from "../../publishing/postiz/postiz.errors.js";

import type { ClipPostsService } from "./clip-posts.service.js";
import type { PostizAnalyticsSource } from "./performance-refresher.js";
import type { ViewRead, ViewReader } from "./youtube-views.js";
import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import type { ClipPost, ClipPostSnapshot } from "@prisma/client";

/**
 * The refresh task against an in-memory stand-in for the two tables it
 * writes: which posts it reads, in what order, how often, what it records,
 * and when it stops - Postiz's allowance and pauses, YouTube's gate.
 */

const NOW = new Date("2026-10-06T12:00:00.000Z");
const HOUR = 60 * 60_000;
const WS = "01JPF0WS000000000000000001";
const OFF_WS = "01JPF0WS000000000000000002";

let sequence = 0;
function row(input: Partial<ClipPost> = {}): ClipPost {
  sequence += 1;
  const id = `01JPF0POST00000000000${String(sequence).padStart(5, "0")}`;
  return {
    id,
    workspaceId: WS,
    runId: "01JPF0RUN0000000000000000A",
    clipId: "01JPF0CLIP000000000000000A",
    aspect: "r9x16",
    language: null,
    platform: "youtube",
    source: "postiz",
    publishTargetId: null,
    externalPostId: `pz-${String(sequence)}`,
    postKey: `postiz:pz-${String(sequence)}`,
    url: null,
    postedAt: new Date(NOW.getTime() - 3 * HOUR),
    postedTimeKnown: true,
    latest: {},
    nextReadAt: new Date(NOW.getTime() - 60_000),
    lastReadAt: null,
    reads: 0,
    readFailures: 0,
    lastReadError: null,
    createdBy: null,
    createdAt: new Date(NOW.getTime() - 3 * HOUR),
    updatedAt: new Date(NOW.getTime() - 3 * HOUR),
    ...input,
  };
}

interface Where {
  readonly source?: string;
  readonly platform?: string;
  readonly externalPostId?: { not: null };
  readonly nextReadAt?: { lte: Date } | Date | null;
  readonly id?: string;
}

function matches(post: ClipPost, where: Where): boolean {
  if (where.id !== undefined && post.id !== where.id) return false;
  if (where.source !== undefined && post.source !== where.source) return false;
  if (where.platform !== undefined && post.platform !== where.platform) return false;
  if (where.externalPostId !== undefined && post.externalPostId === null) return false;
  if (where.nextReadAt !== undefined) {
    const next = where.nextReadAt;
    if (next === null || next instanceof Date) {
      if ((post.nextReadAt?.getTime() ?? null) !== (next?.getTime() ?? null)) return false;
    } else if (post.nextReadAt === null || post.nextReadAt.getTime() > next.lte.getTime()) {
      return false;
    }
  }
  return true;
}

function store(posts: ClipPost[]) {
  const snapshots: ClipPostSnapshot[] = [];
  // A test fake applying its own updates to its own rows.
  /* eslint-disable security/detect-object-injection */
  const update = (id: string, data: Record<string, unknown>): void => {
    const index = posts.findIndex((post) => post.id === id);
    const post = posts[index];
    if (post === undefined) return;
    const next: Record<string, unknown> = { ...post };
    for (const [key, value] of Object.entries(data)) {
      next[key] =
        typeof value === "object" && value !== null && "increment" in value
          ? (next[key] as number) + (value as { increment: number }).increment
          : value;
    }
    posts[index] = next as unknown as ClipPost;
  };
  /* eslint-enable security/detect-object-injection */
  const clipPost = {
    findMany: vi.fn(async ({ where, take }: { where: Where; take: number }) =>
      posts
        .filter((post) => matches(post, where))
        .sort(
          (a, b) =>
            (a.lastReadAt?.getTime() ?? -1) - (b.lastReadAt?.getTime() ?? -1) ||
            (a.nextReadAt?.getTime() ?? 0) - (b.nextReadAt?.getTime() ?? 0) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, take),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id: string } }) =>
        posts.find((post) => post.id === where.id) ?? null,
    ),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        update(where.id, data);
        return posts.find((post) => post.id === where.id);
      },
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      const hit = posts.filter((post) => matches(post, where));
      for (const post of hit) update(post.id, data);
      return { count: hit.length };
    }),
  };
  const clipPostSnapshot = {
    create: vi.fn(async ({ data }: { data: ClipPostSnapshot }) => {
      snapshots.push(data);
      return data;
    }),
  };
  const prisma = {
    clipPost,
    clipPostSnapshot,
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({ clipPost, clipPostSnapshot }),
    ),
  };
  return { prisma, posts, snapshots };
}

function harness(
  posts: ClipPost[],
  options: {
    readonly postiz?: Partial<PostizAnalyticsSource>;
    readonly views?: (videoId: string) => ViewRead;
    readonly perHour?: number;
  } = {},
) {
  const db = store(posts);
  let now = NOW.getTime();
  const service = {
    enabled: vi.fn(async (workspaceId: string) => workspaceId !== OFF_WS),
    adoptPublished: vi.fn(async () => 0),
  };
  const postiz = {
    configured: true,
    postAnalytics: vi.fn(async () => [{ label: "Views", data: [{ total: "1200" }] }]),
    ...options.postiz,
  };
  const views: ViewReader & { read: ReturnType<typeof vi.fn> } = {
    read: vi.fn(async (videoId: string) =>
      options.views === undefined
        ? ({ kind: "views", views: 5_000, publishedAt: null } as const)
        : options.views(videoId),
    ),
  };
  const budget = new ReadBudget(options.perHour ?? 6, () => now);
  const scheduler = { register: vi.fn() };
  const refresher = new PerformanceRefresher(
    db.prisma as unknown as PrismaService,
    service as unknown as ClipPostsService,
    scheduler as unknown as ScheduledTasksService,
    postiz,
    views,
    budget,
  );
  refresher.clock = () => new Date(now);
  const slept: number[] = [];
  refresher.sleep = async (ms) => {
    slept.push(ms);
  };
  return {
    ...db,
    refresher,
    service,
    postiz,
    views,
    budget,
    scheduler,
    slept,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("PerformanceRefresher", () => {
  it("registers the repurpose.performance-refresh task", () => {
    const h = harness([]);
    h.refresher.onModuleInit();
    expect(h.scheduler.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: PERFORMANCE_REFRESH_TASK, everyMs: 10 * 60_000 }),
    );
  });

  it("adopts Postiz posts only for workspaces with the feature on", async () => {
    const h = harness([]);
    await h.refresher.tick();
    const [, options] = h.service.adoptPublished.mock.calls[0] as unknown as [
      unknown,
      { enabled: (workspaceId: string) => Promise<boolean> },
    ];
    expect(await options.enabled(WS)).toBe(true);
    expect(await options.enabled(OFF_WS)).toBe(false);
  });

  it("reads one Postiz post a tick, oldest-read first, and records what it said", async () => {
    const older = row({ lastReadAt: new Date(NOW.getTime() - 5 * HOUR) });
    const never = row({ lastReadAt: null });
    const newer = row({ lastReadAt: new Date(NOW.getTime() - HOUR) });
    const h = harness([newer, older, never]);

    const report = await h.refresher.tick();

    expect(report).toMatchObject({ postizReads: 1, recorded: 1, failed: 0 });
    expect(h.postiz.postAnalytics).toHaveBeenCalledTimes(1);
    // Never read comes first; the window covers its week of life.
    expect(h.postiz.postAnalytics).toHaveBeenCalledWith(never.externalPostId, 7);
    expect(h.snapshots).toEqual([
      expect.objectContaining({ postId: never.id, source: "postiz", views: 1_200, readAt: NOW }),
    ]);
    const read = h.posts.find((post) => post.id === never.id);
    expect(readLatest(read?.latest).views).toEqual({
      value: 1_200,
      source: "postiz",
      at: NOW.toISOString(),
    });
    expect(read).toMatchObject({ reads: 1, readFailures: 0, lastReadAt: NOW });
    // Three hours old: the next read is six hours on.
    expect(read?.nextReadAt).toEqual(new Date(NOW.getTime() + 6 * HOUR));
  });

  it("keeps within the hour's allowance of the shared key", async () => {
    const posts = Array.from({ length: 5 }, () => row());
    const h = harness(posts, { perHour: 2 });
    await h.refresher.tick();
    h.advance(10 * 60_000);
    await h.refresher.tick();
    h.advance(10 * 60_000);
    const third = await h.refresher.tick();
    expect(h.postiz.postAnalytics).toHaveBeenCalledTimes(2);
    expect(third).toMatchObject({ postizReads: 0, postizWaiting: true });
    h.advance(HOUR);
    await h.refresher.tick();
    expect(h.postiz.postAnalytics).toHaveBeenCalledTimes(3);
  });

  it("stops every Postiz read for as long as a 429 asks, holding nothing against the post", async () => {
    const post = row();
    const h = harness([post], {
      postiz: {
        postAnalytics: vi.fn(async () => {
          throw new PostizError("rate_limited", "Postiz answered 429.", {
            status: 429,
            retryAfterMs: 30 * 60_000,
          });
        }),
      },
    });
    const report = await h.refresher.tick();
    expect(report).toMatchObject({ postizWaiting: true, failed: 0 });
    expect(h.posts[0]).toMatchObject({ readFailures: 0, nextReadAt: post.nextReadAt });
    expect(h.budget.pausedUntil).toBe(NOW.getTime() + 30 * 60_000);

    h.advance(20 * 60_000);
    await h.refresher.tick();
    expect(h.postiz.postAnalytics).toHaveBeenCalledTimes(1);
  });

  it("waits an hour on a refused key, and never reads without one", async () => {
    const h = harness([row()], {
      postiz: {
        postAnalytics: vi.fn(async () => {
          throw new PostizError("unauthorized", "Postiz answered 401.", { status: 401 });
        }),
      },
    });
    await h.refresher.tick();
    expect(h.budget.pausedUntil).toBe(NOW.getTime() + POSTIZ_DEFAULT_PAUSE_MS);
    expect(h.posts[0]?.readFailures).toBe(0);

    const unset = harness([row()], { postiz: { configured: false } });
    await unset.refresher.tick();
    expect(unset.postiz.postAnalytics).not.toHaveBeenCalled();
  });

  it("backs a post off when its read finds nothing, and gives up after a few in a row", async () => {
    const post = row({ readFailures: MAX_READ_FAILURES - 1 });
    const h = harness([post], { postiz: { postAnalytics: vi.fn(async () => []) } });
    const report = await h.refresher.tick();
    expect(report).toMatchObject({ failed: 1, recorded: 0 });
    expect(h.posts[0]).toMatchObject({
      readFailures: MAX_READ_FAILURES,
      lastReadError: READ_ERRORS.empty,
      nextReadAt: null,
    });
    expect(h.snapshots).toEqual([]);

    const fresh = harness([row()], {
      postiz: {
        postAnalytics: vi.fn(async () => {
          throw new PostizError("not_found", "Postiz answered 404.", { status: 404 });
        }),
      },
    });
    await fresh.refresher.tick();
    expect(fresh.posts[0]).toMatchObject({
      readFailures: 1,
      lastReadError: READ_ERRORS.missing,
      nextReadAt: new Date(NOW.getTime() + HOUR),
    });
  });

  it("reads YouTube links' views, a few a tick, seconds apart, and fills in when they went out", async () => {
    const posts = [1, 2, 3].map((n) =>
      row({
        source: "link",
        platform: "youtube",
        externalPostId: null,
        postKey: `youtube:video000000${String(n)}`,
        postedAt: null,
      }),
    );
    const published = new Date("2026-10-05T10:00:00.000Z");
    const h = harness(posts, {
      views: () => ({ kind: "views", views: 12_400, publishedAt: published }),
    });
    const report = await h.refresher.tick();
    expect(report).toMatchObject({ youtubeReads: 2, recorded: 2 });
    expect(h.views.read).toHaveBeenCalledWith("video0000001");
    expect(h.slept).toEqual([YOUTUBE_READ_SPACING_MS]);
    expect(h.snapshots.map((snapshot) => snapshot.source)).toEqual([
      "youtube_page",
      "youtube_page",
    ]);
    expect(h.posts[0]).toMatchObject({ postedAt: published, postedTimeKnown: true });
  });

  it("stops reading YouTube the moment it refuses, and leaves those posts due", async () => {
    const posts = [1, 2].map((n) =>
      row({
        source: "link",
        platform: "youtube",
        externalPostId: null,
        postKey: `youtube:video000000${String(n)}`,
      }),
    );
    const h = harness(posts, { views: () => ({ kind: "blocked" }) });
    const report = await h.refresher.tick();
    expect(report).toMatchObject({ youtubeBusy: true, youtubeReads: 0, failed: 0 });
    expect(h.views.read).toHaveBeenCalledTimes(1);
    expect(h.posts.every((post) => post.readFailures === 0)).toBe(true);
  });

  it("names why a YouTube read found nothing", async () => {
    const post = row({
      source: "link",
      platform: "youtube",
      externalPostId: null,
      postKey: "youtube:video0000001",
    });
    const h = harness([post], { views: () => ({ kind: "unavailable", reason: "private" }) });
    await h.refresher.tick();
    expect(h.posts[0]).toMatchObject({ readFailures: 1, lastReadError: READ_ERRORS.unavailable });
  });

  it("never reads other platforms' links, and leaves workspaces with the feature off for a day", async () => {
    const instagram = row({
      source: "link",
      platform: "instagram",
      externalPostId: null,
      postKey: "instagram:C8xYz12AbCd",
    });
    const off = row({ workspaceId: OFF_WS });
    const h = harness([instagram, off]);
    const report = await h.refresher.tick();
    expect(report).toMatchObject({ postizReads: 0, youtubeReads: 0 });
    expect(h.postiz.postAnalytics).not.toHaveBeenCalled();
    expect(h.views.read).not.toHaveBeenCalled();
    expect(h.posts.find((post) => post.id === off.id)?.nextReadAt).toEqual(
      new Date(NOW.getTime() + 24 * HOUR),
    );
  });

  it("does not run two ticks at once", async () => {
    const h = harness([row()]);
    let release: () => void = () => undefined;
    h.postiz.postAnalytics = vi.fn(
      async () =>
        new Promise<unknown>((resolve) => {
          release = () => {
            resolve([{ label: "Views", data: [{ total: "1" }] }]);
          };
        }),
    );
    const first = h.refresher.tick();
    await vi.waitFor(() => {
      expect(h.postiz.postAnalytics).toHaveBeenCalled();
    });
    expect(await h.refresher.tick()).toMatchObject({ overlapped: true });
    release();
    expect(await first).toMatchObject({ overlapped: false, recorded: 1 });
  });
});
