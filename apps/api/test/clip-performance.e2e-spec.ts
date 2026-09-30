/**
 * Learning what works (2026-10-05) against a real PostgreSQL: the migration's
 * two tables, and what the unit tests can only imitate - adopting the Postiz
 * posts that went out (the `clipPost: { is: null }` relation filter), the
 * `(workspace, post_key)` uniqueness that makes a video one post and turns a
 * link pasted first into the Postiz post, the snapshot history, the refresh
 * task's due queue (`lastReadAt` nulls first), the reads "What works" and the
 * steering signal make, tenancy, and the cascades.
 *
 * Postiz and YouTube are fakes: nothing here reaches a network, a bucket or
 * Redis.
 */
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { CommonAuditService } from "../src/common/audit/audit.service.js";
import { AppException } from "../src/common/errors/error-codes.js";
import { ClipPostsService } from "../src/repurpose/performance/clip-posts.service.js";
import { PerformanceRefresher } from "../src/repurpose/performance/performance-refresher.js";
import { ReadBudget } from "../src/repurpose/performance/read-budget.js";
import { performanceSignalFor } from "../src/repurpose/performance/steering-signal.js";
import { WhatWorksService } from "../src/repurpose/performance/what-works.service.js";

import type { TestDatabase } from "./db-harness.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../src/common/scheduler/scheduled-tasks.service.js";
import type { ViewRead } from "../src/repurpose/performance/youtube-views.js";
import type { RepurposeService } from "../src/repurpose/repurpose.service.js";
import type { PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable();

if (!available) {
  console.warn(
    "[clip-performance.e2e] SKIPPED - no test database. Set TEST_DATABASE_URL, or start Docker. " +
      `Reason: ${skipReason}`,
  );
}

const BASE = "01JPF000000000000000000000";
const id = (suffix: string): string => (BASE.slice(0, 26 - suffix.length) + suffix).toUpperCase();

const OWNER = id("U1");
const WS = id("W1");
const OTHER_WS = id("W2");
const SOURCE = id("P1");
const OTHER_SOURCE = id("P2");
const RUN = id("R1");
const OTHER_RUN = id("R2");
const BATCH = id("B1");
const NOW = new Date("2026-10-06T12:00:00.000Z");

describe.skipIf(!available)("learning what works against PostgreSQL", () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let posts: ClipPostsService;
  let whatWorks: WhatWorksService;
  let now = NOW.getTime();
  const postizCalls: string[] = [];
  let viewRead: ViewRead = { kind: "views", views: 12_400, publishedAt: null };

  /** A clip in `runId`, with a variant (and its project) per shape. */
  async function seedClip(
    workspaceId: string,
    runId: string,
    n: number,
    shapes: readonly ("r9x16" | "r1x1")[] = ["r9x16"],
  ): Promise<{ clipId: string; variants: Record<string, string> }> {
    const candidateId = id(`${runId.slice(-2)}C${String(n)}`);
    const clipId = id(`${runId.slice(-2)}K${String(n)}`);
    await prisma.clipCandidate.create({
      data: {
        id: candidateId,
        runId,
        source: "ai",
        rank: n,
        potentialScore: 70,
        startMs: n * 60_000,
        endMs: n * 60_000 + 30_000,
        title: `Moment ${String(n)}`,
        transcriptExcerpt: `What was said in moment ${String(n)}.`,
        state: "materialized",
      },
    });
    await prisma.repurposeClip.create({
      data: {
        id: clipId,
        runId,
        candidateId,
        title: `Clip ${String(n)}`,
        sourceStartMs: n * 60_000,
        sourceEndMs: n * 60_000 + 30_000,
      },
    });
    const variants: Record<string, string> = {};
    for (const aspect of shapes) {
      const projectId = ulid();
      await prisma.project.create({
        data: { id: projectId, workspaceId, title: `Clip ${String(n)} ${aspect}` },
      });
      const variantId = ulid();
      await prisma.clipVariant.create({
        data: { id: variantId, clipId, projectId, aspect, status: "ready" },
      });
      // eslint-disable-next-line security/detect-object-injection -- a shape from the closed list above
      variants[aspect] = variantId;
    }
    return { clipId, variants };
  }

  /** A post that went out through Postiz, as the dispatcher leaves it. */
  async function published(input: {
    readonly clipId: string;
    readonly variantId: string;
    readonly provider: string;
    readonly externalPostId: string;
    readonly externalUrl?: string | null;
    readonly status?: "published" | "failed_permanent";
    readonly settings?: Record<string, unknown>;
  }): Promise<string> {
    const targetId = ulid();
    await prisma.publishTarget.create({
      data: {
        id: targetId,
        workspaceId: WS,
        batchId: BATCH,
        clipId: input.clipId,
        variantId: input.variantId,
        provider: input.provider,
        publishMode: "direct",
        idempotencyKey: `postiz:${input.clipId}:${targetId}:now`,
        status: input.status ?? "published",
        externalPostId: input.externalPostId,
        externalUrl: input.externalUrl ?? null,
        publishedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
        settings: (input.settings ?? {}) as object,
      },
    });
    return targetId;
  }

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error(`no test database: ${skipReason}`);
    db = created;
    prisma = db.prisma;

    await prisma.user.create({ data: { id: OWNER, email: "pf-owner@example.test", name: "Asha" } });
    for (const [workspaceId, slug, source, run] of [
      [WS, "pf-one", SOURCE, RUN],
      [OTHER_WS, "pf-two", OTHER_SOURCE, OTHER_RUN],
    ] as const) {
      await prisma.workspace.create({
        data: { id: workspaceId, slug, name: slug, ownerId: OWNER, billingCountry: "IN" },
      });
      await prisma.project.create({ data: { id: source, workspaceId, title: "Episode 12" } });
      await prisma.repurposeRun.create({
        data: {
          id: run,
          workspaceId,
          sourceProjectId: source,
          sourceKind: "upload",
          mode: "ai",
          createdBy: OWNER,
          config: { sourceLanguage: "hi-Latn", discovery: { topic: "money" } },
        },
      });
    }
    await prisma.publishBatch.create({
      data: { id: BATCH, runId: RUN, workspaceId: WS, timezone: "Asia/Kolkata" },
    });

    const service = prisma as unknown as PrismaService;
    const runs = { flagEnabled: async () => true } as unknown as RepurposeService;
    posts = new ClipPostsService(service, runs, new CommonAuditService(service), {
      scheduled: ["repurpose.performance-refresh"],
    } as unknown as ScheduledTasksService);
    posts.now = () => new Date(now);
    whatWorks = new WhatWorksService(service, posts);
    whatWorks.now = () => new Date(now);
  });

  afterAll(async () => {
    await db?.stop();
  });

  function refresher(perHour = 6): PerformanceRefresher {
    const task = new PerformanceRefresher(
      prisma as unknown as PrismaService,
      posts,
      { register: () => undefined } as unknown as ScheduledTasksService,
      {
        configured: true,
        postAnalytics: async (postId: string) => {
          postizCalls.push(postId);
          return [
            { label: "Views", data: [{ total: "3000", date: "2026-10-06" }] },
            { label: "Likes", data: [{ total: "120", date: "2026-10-06" }] },
          ];
        },
      },
      { read: async () => viewRead },
      new ReadBudget(perHour, () => now),
    );
    task.clock = () => new Date(now);
    task.sleep = async () => undefined;
    return task;
  }

  async function refusal(work: Promise<unknown>): Promise<AppException> {
    try {
      await work;
    } catch (error) {
      if (error instanceof AppException) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  it("creates the two tables and enums, with one post per platform id per workspace", async () => {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('clip_posts', 'clip_post_snapshots')`;
    expect(tables.map((row) => row.table_name).sort()).toEqual([
      "clip_post_snapshots",
      "clip_posts",
    ]);
    const enums = await prisma.$queryRaw<{ typname: string }[]>`
      SELECT typname FROM pg_type WHERE typname IN ('ClipPostSource', 'ClipMetricSource')`;
    expect(enums).toHaveLength(2);
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'clip_posts'`;
    expect(indexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "clip_posts_workspace_id_post_key_key",
        "clip_posts_publish_target_id_key",
        "clip_posts_next_read_at_idx",
      ]),
    );
  });

  it("adopts what went out through Postiz, once, filed under the platform's own id", async () => {
    const one = await seedClip(WS, RUN, 1, ["r9x16", "r1x1"]);
    const two = await seedClip(WS, RUN, 2);
    const youtube = await published({
      clipId: one.clipId,
      variantId: one.variants["r9x16"] ?? "",
      provider: "youtube",
      externalPostId: "pz-yt-1",
      externalUrl: "https://youtube.com/shorts/Zgu97mCGS74",
    });
    await published({
      clipId: one.clipId,
      variantId: one.variants["r1x1"] ?? "",
      provider: "linkedin",
      externalPostId: "pz-li-1",
      settings: { provider: "linkedin", surface: "member" },
    });
    await published({
      clipId: two.clipId,
      variantId: two.variants["r9x16"] ?? "",
      provider: "instagram",
      externalPostId: "pz-ig-1",
    });
    await published({
      clipId: two.clipId,
      variantId: two.variants["r9x16"] ?? "",
      provider: "x",
      externalPostId: "pz-x-failed",
      status: "failed_permanent",
    });

    const view = await posts.runPerformance(WS, RUN);
    expect(view.enabled).toBe(true);
    expect(view.readsEnabled).toBe(true);
    expect(
      view.posts.map((post) => [post.platform, post.shape, post.reading.state]).sort(),
    ).toEqual([
      ["instagram", "9:16", "reading"],
      ["linkedin", "1:1", "manual"],
      ["youtube", "9:16", "reading"],
    ]);
    const row = await prisma.clipPost.findUnique({ where: { publishTargetId: youtube } });
    expect(row).toMatchObject({
      postKey: "youtube:Zgu97mCGS74",
      url: "https://www.youtube.com/shorts/Zgu97mCGS74",
      source: "postiz",
      externalPostId: "pz-yt-1",
    });
    expect(view.clips.find((clip) => clip.clipId === one.clipId)?.shapes).toEqual(["9:16", "1:1"]);

    // Asked again: nothing new.
    expect(await posts.adoptPublished({ workspaceId: WS })).toBe(0);
    expect(await prisma.clipPost.count({ where: { workspaceId: WS } })).toBe(3);
  });

  it("gives a Postiz post with no link the link pasted for it, not a second post", async () => {
    const two = await prisma.repurposeClip.findFirstOrThrow({
      where: { runId: RUN, title: "Clip 2" },
    });
    const view = await posts.addLink(WS, OWNER, RUN, two.id, {
      url: "https://www.instagram.com/reel/DAbCdEfGhIj/?igsh=x",
    });
    expect(view).toMatchObject({
      source: "postiz",
      url: "https://www.instagram.com/reel/DAbCdEfGhIj/",
    });
    expect(await prisma.clipPost.count({ where: { clipId: two.id } })).toBe(1);
    expect(
      await prisma.clipPost.findFirstOrThrow({ where: { externalPostId: "pz-ig-1" } }),
    ).toMatchObject({ postKey: "instagram:DAbCdEfGhIj" });
  });

  it("makes a link pasted before its post was adopted that post, numbers and all", async () => {
    const three = await seedClip(WS, RUN, 3);
    const pasted = await posts.addLink(WS, OWNER, RUN, three.clipId, {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=share",
    });
    await posts.enterNumbers(WS, OWNER, RUN, pasted.id, { likes: 40 });

    const target = await published({
      clipId: three.clipId,
      variantId: three.variants["r9x16"] ?? "",
      provider: "youtube",
      externalPostId: "pz-yt-3",
      externalUrl: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(await posts.adoptPublished({ workspaceId: WS })).toBe(1);

    const rows = await prisma.clipPost.findMany({ where: { postKey: "youtube:dQw4w9WgXcQ" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: pasted.id,
      source: "postiz",
      publishTargetId: target,
      externalPostId: "pz-yt-3",
    });
    expect(await prisma.clipPostSnapshot.count({ where: { postId: pasted.id } })).toBe(1);
  });

  it("refuses the same post twice in a workspace, and not in another", async () => {
    const four = await seedClip(WS, RUN, 4);
    const url = "https://www.instagram.com/reel/C8xYz12AbCd/?igsh=abc";
    const first = await posts.addLink(WS, OWNER, RUN, four.clipId, { url, language: undefined });
    const again = await refusal(
      posts.addLink(WS, OWNER, RUN, four.clipId, {
        url: "https://instagram.com/aksharo/reel/C8xYz12AbCd",
      }),
    );
    expect(again).toMatchObject({
      code: "performance/post_exists",
      details: { postId: first.id, clipId: four.clipId },
    });

    const elsewhere = await seedClip(OTHER_WS, OTHER_RUN, 1);
    const theirs = await posts.addLink(OTHER_WS, OWNER, OTHER_RUN, elsewhere.clipId, { url });
    expect(theirs.id).not.toBe(first.id);

    // Another workspace's run, clip or post is not found from here.
    expect((await refusal(posts.runPerformance(WS, OTHER_RUN))).code).toBe("repurpose/not_found");
    expect(
      (
        await refusal(
          posts.addLink(WS, OWNER, RUN, elsewhere.clipId, { url: "https://youtu.be/aaaaaaaaaaa" }),
        )
      ).code,
    ).toBe("performance/clip_not_found");
    expect((await refusal(posts.removePost(WS, OWNER, RUN, theirs.id))).code).toBe(
      "performance/post_not_found",
    );
  });

  it("keeps every set of numbers, and each number's newest with its source", async () => {
    const five = await seedClip(WS, RUN, 5);
    const post = await posts.addLink(WS, OWNER, RUN, five.clipId, {
      url: "https://www.tiktok.com/@aksharo/video/7312345678901234567",
    });
    await posts.enterNumbers(WS, OWNER, RUN, post.id, { views: 900, likes: 30 });
    now += 60 * 60_000;
    const view = await posts.enterNumbers(WS, OWNER, RUN, post.id, { views: 1_500 });
    expect(await prisma.clipPostSnapshot.count({ where: { postId: post.id } })).toBe(2);
    expect(view.numbers.views).toMatchObject({ value: 1_500, source: "person", measured: false });
    expect(view.numbers.likes).toMatchObject({ value: 30, source: "person" });
    expect(view.reading.state).toBe("manual");
  });

  it("reads what is due, oldest-read first, and records it", async () => {
    postizCalls.length = 0;
    // Two Postiz posts are due, the rest not; the one never read goes first.
    await prisma.clipPost.updateMany({
      where: { workspaceId: WS, source: "postiz" },
      data: { nextReadAt: new Date(now + 60 * 60_000) },
    });
    await prisma.clipPost.updateMany({
      where: { workspaceId: WS, externalPostId: "pz-ig-1" },
      data: { lastReadAt: new Date(now - 60 * 60_000), nextReadAt: new Date(now - 1_000) },
    });
    await prisma.clipPost.updateMany({
      where: { workspaceId: WS, externalPostId: "pz-yt-1" },
      data: { lastReadAt: null, nextReadAt: new Date(now - 1_000) },
    });
    const report = await refresher().tick();
    expect(postizCalls).toEqual(["pz-yt-1"]);
    expect(report).toMatchObject({ postizReads: 1, recorded: expect.any(Number) });

    const read = await prisma.clipPost.findFirstOrThrow({ where: { externalPostId: "pz-yt-1" } });
    expect(read.reads).toBe(1);
    expect(read.nextReadAt?.getTime()).toBeGreaterThan(now);
    const snapshot = await prisma.clipPostSnapshot.findFirstOrThrow({
      where: { postId: read.id, source: "postiz" },
    });
    expect(snapshot).toMatchObject({ views: 3_000, likes: 120 });
  });

  it("reads a pasted YouTube link's views from its page", async () => {
    const six = await seedClip(WS, RUN, 6);
    const post = await posts.addLink(WS, OWNER, RUN, six.clipId, {
      url: "https://www.youtube.com/shorts/aaaaaaaaaaa",
    });
    viewRead = { kind: "views", views: 12_400, publishedAt: new Date("2026-10-05T08:00:00.000Z") };
    await refresher().tick();
    const row = await prisma.clipPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(row.postedAt).toEqual(new Date("2026-10-05T08:00:00.000Z"));
    expect(row.latest).toMatchObject({ views: { value: 12_400, source: "youtube_page" } });
  });

  it("answers What works and the steering signal from real rows", async () => {
    const view = await whatWorks.whatWorks(WS, 90);
    expect(view.timeZone).toBe("Asia/Kolkata");
    expect(view.totals.posts).toBeGreaterThanOrEqual(6);
    expect(view.totals.withViews).toBeGreaterThanOrEqual(3);
    // Too few posts with views for anything to be claimed yet.
    expect(view.findings).toEqual([]);
    expect(await performanceSignalFor(prisma as unknown as PrismaService, WS, new Date(now))).toBe(
      null,
    );
  });

  it("goes with its run", async () => {
    const before = await prisma.clipPost.count({ where: { workspaceId: OTHER_WS } });
    expect(before).toBe(1);
    await prisma.repurposeRun.delete({ where: { id: OTHER_RUN } });
    expect(await prisma.clipPost.count({ where: { workspaceId: OTHER_WS } })).toBe(0);
  });
});
