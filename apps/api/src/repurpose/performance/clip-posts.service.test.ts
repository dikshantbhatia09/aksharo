import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ClipPostsService, readsItself } from "./clip-posts.service.js";
import { PERFORMANCE_ERRORS, PERFORMANCE_FLAG, READ_ERRORS } from "./performance.constants.js";
import { MAX_READ_FAILURES } from "./refresh-plan.js";
import { AppException } from "../../common/errors/error-codes.js";

import type { CommonAuditService } from "../../common/audit/audit.service.js";
import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { RepurposeService } from "../repurpose.service.js";
import type { ClipPost } from "@prisma/client";

/**
 * The routes' service with the database stood in for: who may do what, what
 * a link and its shape, language and date must be, what is audited, and how a
 * post's numbers and reading are described. The queries themselves run
 * against PostgreSQL in `test/clip-performance.e2e-spec.ts`.
 */

const WS = "01JPS0WS000000000000000001";
const USER = "01JPS0USER0000000000000001";
const RUN = "01JPS0RUN00000000000000001";
const CLIP = "01JPS0CLIP0000000000000001";
const POST = "01JPS0POST0000000000000001";
const NOW = new Date("2026-10-06T12:00:00.000Z");

function post(input: Partial<ClipPost> = {}): ClipPost {
  return {
    id: POST,
    workspaceId: WS,
    runId: RUN,
    clipId: CLIP,
    aspect: "r9x16",
    language: null,
    platform: "youtube",
    source: "link",
    publishTargetId: null,
    externalPostId: null,
    postKey: "youtube:dQw4w9WgXcQ",
    url: "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    postedAt: null,
    postedTimeKnown: false,
    latest: {},
    nextReadAt: NOW,
    lastReadAt: null,
    reads: 0,
    readFailures: 0,
    lastReadError: null,
    createdBy: USER,
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  };
}

function harness(
  options: {
    readonly flags?: Record<string, boolean>;
    readonly clip?: unknown;
    readonly existing?: ClipPost | null;
    readonly count?: number;
    readonly createError?: unknown;
  } = {},
) {
  const flags = options.flags ?? { repurpose_flow: true, [PERFORMANCE_FLAG]: true };
  const created: unknown[] = [];
  const snapshots: unknown[] = [];
  const prisma = {
    repurposeRun: { findFirst: vi.fn(async () => ({ id: RUN })) },
    repurposeClip: {
      findFirst: vi.fn(async () =>
        options.clip === undefined
          ? {
              id: CLIP,
              variants: [{ aspect: "r9x16" }, { aspect: "r1x1" }],
              dubs: [{ variants: [{ language: "hi-IN" }, { language: "ta-IN" }] }],
            }
          : options.clip,
      ),
    },
    clipPost: {
      count: vi.fn(async () => options.count ?? 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (options.createError !== undefined) throw options.createError;
        created.push(data);
        return post({ ...(data as Partial<ClipPost>), createdAt: NOW, updatedAt: NOW });
      }),
      findUnique: vi.fn(async () =>
        options.existing === undefined || options.existing === null
          ? null
          : { id: options.existing.id, clipId: options.existing.clipId },
      ),
      findFirst: vi.fn(async () => options.existing ?? null),
      findUniqueOrThrow: vi.fn(async () => ({ latest: options.existing?.latest ?? {} })),
      update: vi.fn(async ({ data }: { data: Partial<ClipPost> }) => ({
        ...post(options.existing ?? {}),
        ...data,
        publishTarget: null,
      })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    clipPostSnapshot: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        snapshots.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
  };
  const runs = {
    // eslint-disable-next-line security/detect-object-injection -- a flag name from this test
    flagEnabled: vi.fn(async (_workspaceId: string, flag: string) => flags[flag] === true),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new ClipPostsService(
    prisma as unknown as PrismaService,
    runs as unknown as RepurposeService,
    audit as unknown as CommonAuditService,
  );
  service.now = () => NOW;
  return { service, prisma, audit, created, snapshots };
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

describe("ClipPostsService flags", () => {
  it("answers 404 for everything while the clips pipeline is off", async () => {
    const h = harness({ flags: { [PERFORMANCE_FLAG]: true } });
    for (const work of [
      h.service.runPerformance(WS, RUN),
      h.service.addLink(WS, USER, RUN, CLIP, { url: "https://youtu.be/dQw4w9WgXcQ" }),
      h.service.enterNumbers(WS, USER, RUN, POST, { views: 3 }),
      h.service.removePost(WS, USER, RUN, POST),
    ]) {
      const error = await refusal(work);
      expect(error).toMatchObject({
        code: PERFORMANCE_ERRORS.disabled,
        httpStatus: HttpStatus.NOT_FOUND,
      });
    }
  });

  it("shows no panel, and changes nothing, while only this feature is off", async () => {
    const h = harness({ flags: { repurpose_flow: true } });
    expect(await h.service.runPerformance(WS, RUN)).toEqual({
      runId: RUN,
      enabled: false,
      posts: [],
      clips: [],
    });
    const error = await refusal(
      h.service.addLink(WS, USER, RUN, CLIP, { url: "https://youtu.be/dQw4w9WgXcQ" }),
    );
    expect(error.code).toBe(PERFORMANCE_ERRORS.disabled);
    expect(h.prisma.clipPost.create).not.toHaveBeenCalled();
  });
});

describe("ClipPostsService.addLink", () => {
  it("follows a YouTube Short in a shape the clip has, read by itself from now", async () => {
    const h = harness();
    const view = await h.service.addLink(WS, USER, RUN, CLIP, {
      url: "https://youtube.com/shorts/dQw4w9WgXcQ?si=abc",
      shape: "1:1",
      postedAt: "2026-10-04",
    });
    expect(h.created[0]).toMatchObject({
      workspaceId: WS,
      runId: RUN,
      clipId: CLIP,
      aspect: "r1x1",
      platform: "youtube",
      source: "link",
      postKey: "youtube:dQw4w9WgXcQ",
      url: "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      postedAt: new Date("2026-10-04T12:00:00.000Z"),
      // A day alone says nothing about the hour.
      postedTimeKnown: false,
      nextReadAt: NOW,
      createdBy: USER,
    });
    expect(view).toMatchObject({
      platform: "youtube",
      platformLabel: "YouTube",
      shape: "1:1",
      source: "link",
      canRemove: true,
      reading: { state: "reading", nextAt: NOW.toISOString(), note: null },
    });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "repurpose.performance.post_added",
        resource: "clip_post",
        actorId: USER,
        workspaceId: WS,
        data: { runId: RUN, clipId: CLIP, platform: "youtube", shape: "1:1", language: null },
      }),
    );
  });

  it("keeps the hour a post went out when it is given one", async () => {
    const h = harness();
    await h.service.addLink(WS, USER, RUN, CLIP, {
      url: "https://x.com/aksharo/status/1840000000000000001",
      postedAt: "2026-10-04T19:30:00+05:30",
    });
    expect(h.created[0]).toMatchObject({
      platform: "x",
      postedAt: new Date("2026-10-04T14:00:00.000Z"),
      postedTimeKnown: true,
      // X links are not read by themselves: their numbers are typed in.
      nextReadAt: null,
    });
  });

  it("follows an Instagram reel of a dub, whose numbers are typed in", async () => {
    const h = harness();
    const view = await h.service.addLink(WS, USER, RUN, CLIP, {
      url: "https://www.instagram.com/reel/C8xYz12AbCd/",
      language: "hi-IN",
    });
    expect(h.created[0]).toMatchObject({ language: "hi-IN", nextReadAt: null, aspect: "r9x16" });
    expect(view.reading).toEqual({
      state: "manual",
      nextAt: null,
      note: "Aksharo cannot read Instagram numbers by itself: type them in when you check.",
    });
  });

  it("refuses what it cannot follow, with the reason", async () => {
    const cases: [Record<string, string>, string, HttpStatus][] = [
      [{ url: "https://vimeo.com/1" }, "performance/link_unsupported", HttpStatus.BAD_REQUEST],
      [{ url: "https://vm.tiktok.com/abc/" }, "performance/link_short", HttpStatus.BAD_REQUEST],
      [
        { url: "https://youtu.be/dQw4w9WgXcQ", shape: "16:9" },
        PERFORMANCE_ERRORS.shapeUnknown,
        HttpStatus.BAD_REQUEST,
      ],
      [
        { url: "https://youtu.be/dQw4w9WgXcQ", language: "bn-IN" },
        PERFORMANCE_ERRORS.languageUnknown,
        HttpStatus.BAD_REQUEST,
      ],
      [
        { url: "https://youtu.be/dQw4w9WgXcQ", postedAt: "2026-10-09" },
        PERFORMANCE_ERRORS.dateInvalid,
        HttpStatus.BAD_REQUEST,
      ],
      [
        { url: "https://youtu.be/dQw4w9WgXcQ", postedAt: "1999-01-01" },
        PERFORMANCE_ERRORS.dateInvalid,
        HttpStatus.BAD_REQUEST,
      ],
    ];
    for (const [input, code, status] of cases) {
      const h = harness();
      const error = await refusal(h.service.addLink(WS, USER, RUN, CLIP, input as never));
      expect({ code: error.code, status: error.httpStatus }, JSON.stringify(input)).toEqual({
        code,
        status,
      });
      expect(h.prisma.clipPost.create).not.toHaveBeenCalled();
    }
  });

  it("says so when the clip is not in the run, or carries too many posts", async () => {
    const missing = harness({ clip: null });
    expect(
      (
        await refusal(
          missing.service.addLink(WS, USER, RUN, CLIP, { url: "https://youtu.be/dQw4w9WgXcQ" }),
        )
      ).code,
    ).toBe(PERFORMANCE_ERRORS.clipNotFound);
    const full = harness({ count: 40 });
    expect(
      (
        await refusal(
          full.service.addLink(WS, USER, RUN, CLIP, { url: "https://youtu.be/dQw4w9WgXcQ" }),
        )
      ).code,
    ).toBe(PERFORMANCE_ERRORS.tooManyPosts);
  });

  it("refuses a post already recorded, and says where", async () => {
    const h = harness({
      createError: Object.assign(new Error("unique"), { code: "P2002" }),
      existing: post({ id: "01JPS0POST0000000000000009", clipId: "01JPS0CLIP0000000000000009" }),
    });
    const error = await refusal(
      h.service.addLink(WS, USER, RUN, CLIP, { url: "https://youtu.be/dQw4w9WgXcQ" }),
    );
    expect(error).toMatchObject({
      code: PERFORMANCE_ERRORS.postExists,
      httpStatus: HttpStatus.CONFLICT,
      details: { postId: "01JPS0POST0000000000000009", clipId: "01JPS0CLIP0000000000000009" },
    });
    expect(error.message).toBe("This post is already recorded, on another clip.");
    expect(h.audit.record).not.toHaveBeenCalled();
  });
});

describe("ClipPostsService.enterNumbers and removePost", () => {
  it("keeps typed numbers as a snapshot, beside what was measured", async () => {
    const measured = {
      views: { value: 1_000, source: "youtube_page", at: "2026-10-06T06:00:00.000Z" },
    };
    const h = harness({ existing: post({ latest: measured }) });
    const view = await h.service.enterNumbers(WS, USER, RUN, POST, { likes: 80, comments: 4 });
    expect(h.snapshots).toEqual([
      expect.objectContaining({
        postId: POST,
        source: "person",
        views: null,
        likes: 80,
        comments: 4,
        shares: null,
        readAt: NOW,
        enteredBy: USER,
      }),
    ]);
    expect(view.numbers).toEqual({
      views: {
        value: 1_000,
        source: "youtube_page",
        measured: true,
        at: "2026-10-06T06:00:00.000Z",
      },
      likes: { value: 80, source: "person", measured: false, at: NOW.toISOString() },
      comments: { value: 4, source: "person", measured: false, at: NOW.toISOString() },
      shares: null,
    });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "repurpose.performance.numbers_entered",
        data: { runId: RUN, clipId: CLIP, likes: 80, comments: 4 },
      }),
    );
  });

  it("refuses numbers with none in them, and a post not in the run", async () => {
    const h = harness({ existing: post() });
    expect((await refusal(h.service.enterNumbers(WS, USER, RUN, POST, {}))).code).toBe(
      PERFORMANCE_ERRORS.numbersEmpty,
    );
    const none = harness({ existing: null });
    expect((await refusal(none.service.enterNumbers(WS, USER, RUN, POST, { views: 1 }))).code).toBe(
      PERFORMANCE_ERRORS.postNotFound,
    );
  });

  it("removes a pasted link, never a Postiz post", async () => {
    const h = harness({ existing: post() });
    expect(await h.service.removePost(WS, USER, RUN, POST)).toEqual({ removed: true });
    expect(h.prisma.clipPost.deleteMany).toHaveBeenCalledWith({
      where: { id: POST, workspaceId: WS },
    });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repurpose.performance.post_removed", resourceId: POST }),
    );

    const postiz = harness({ existing: post({ source: "postiz", externalPostId: "pz-1" }) });
    expect(await refusal(postiz.service.removePost(WS, USER, RUN, POST))).toMatchObject({
      code: PERFORMANCE_ERRORS.postNotRemovable,
      httpStatus: HttpStatus.CONFLICT,
    });
    expect(postiz.prisma.clipPost.deleteMany).not.toHaveBeenCalled();
  });
});

describe("how a post's reading is described", () => {
  const { service } = harness();

  it("says when it is read next, or that its month is read", () => {
    expect(service.view(post(), null).reading.state).toBe("reading");
    expect(service.view(post({ nextReadAt: null, reads: 20 }), null).reading).toEqual({
      state: "done",
      nextAt: null,
      note: "Its first month is read.",
    });
  });

  it("says why reading stopped", () => {
    expect(
      service.view(
        post({
          nextReadAt: null,
          readFailures: MAX_READ_FAILURES,
          lastReadError: READ_ERRORS.unavailable,
        }),
        null,
      ).reading,
    ).toEqual({
      state: "stopped",
      nextAt: null,
      note: "The video is private, removed or not out yet, so its numbers cannot be read.",
    });
  });

  it("knows a personal LinkedIn post's numbers are never shared", () => {
    expect(readsItself("postiz", "linkedin", { surface: "member" })).toBe(false);
    expect(readsItself("postiz", "linkedin", { surface: "organization" })).toBe(true);
    expect(readsItself("postiz", "instagram", null)).toBe(true);
    expect(readsItself("link", "youtube", null)).toBe(true);
    expect(readsItself("link", "tiktok", null)).toBe(false);
    const view = service.view(post({ source: "postiz", platform: "linkedin", nextReadAt: null }), {
      surface: "member",
    });
    expect(view.reading).toEqual({
      state: "manual",
      nextAt: null,
      note: "LinkedIn does not share numbers for personal posts: type them in when you check.",
    });
    expect(view.canRemove).toBe(false);
  });

  it("gives engagement only over enough views", () => {
    const at = NOW.toISOString();
    const counted = service.view(
      post({
        latest: {
          views: { value: 1_000, source: "postiz", at },
          likes: { value: 50, source: "postiz", at },
        },
      }),
      null,
    );
    expect(counted.engagementRate).toBeCloseTo(0.05);
    const thin = service.view(
      post({
        latest: {
          views: { value: 20, source: "postiz", at },
          likes: { value: 5, source: "postiz", at },
        },
      }),
      null,
    );
    expect(thin.engagementRate).toBeNull();
  });
});
