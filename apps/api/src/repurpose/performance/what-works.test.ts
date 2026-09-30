import { describe, expect, it } from "vitest";

import { PerformanceSignalSchema } from "@montaj/repurpose-contracts";

import {
  CLEAR_LIFT,
  MIN_GROUP,
  describeSignal,
  insightsOf,
  median,
  relativeViews,
  steeringSignalOf,
} from "./what-works.js";

import type { ClipFacts, PostFacts } from "./what-works.js";

const IST = "Asia/Kolkata";
let sequence = 0;

type PostInput = Partial<Omit<PostFacts, "clip">> & { readonly clip?: Partial<ClipFacts> };

function post(input: PostInput = {}): PostFacts {
  sequence += 1;
  const { clip, ...rest } = input;
  return {
    postId: `post-${String(sequence)}`,
    platform: "youtube",
    url: null,
    views: 1_000,
    likes: null,
    comments: null,
    shares: null,
    viewsMeasured: true,
    postedAt: new Date("2026-10-01T06:00:00Z"),
    timeKnown: true,
    at: new Date("2026-10-01T06:00:00Z"),
    layout: "single",
    language: "hi-Latn",
    ...rest,
    clip: {
      clipId: `clip-${String(sequence)}`,
      runId: "run-1",
      title: `Clip number ${String(sequence)}`,
      hook: null,
      excerpt: "",
      durationMs: 30_000,
      ...clip,
    },
  };
}

function many(count: number, input: PostInput): PostFacts[] {
  return Array.from({ length: count }, () => post(input));
}

describe("the small statistics", () => {
  it("takes medians of odd and even lists", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("reads each post against its own platform's usual views", () => {
    const posts = [
      post({ platform: "youtube", views: 1_000 }),
      post({ platform: "youtube", views: 2_000 }),
      post({ platform: "youtube", views: 3_000 }),
      post({ platform: "linkedin", views: 100 }),
      post({ platform: "instagram", views: null }),
      post({ platform: "x", views: 0 }),
    ];
    const relative = relativeViews(posts);
    expect(posts.map((entry) => relative.get(entry.postId))).toEqual([
      0.5,
      1,
      1.5,
      1,
      undefined,
      undefined,
    ]);
  });
});

describe("insightsOf", () => {
  it("says nothing from fewer than a handful of posts with views", () => {
    const posts = [...many(4, { views: 900 }), ...many(3, { views: null })];
    const insights = insightsOf(posts, IST);
    expect(insights.enough).toBe(false);
    expect(insights.totals).toEqual({
      posts: 7,
      withViews: 4,
      measured: 4,
      entered: 0,
      clips: 7,
    });
    expect(insights.topByViews).toEqual([]);
    expect(insights.dimensions).toEqual([]);
    expect(insights.findings).toEqual([]);
  });

  it("finds the length that did clearly better, with the posts behind it", () => {
    const posts = [
      ...many(5, { views: 2_000, clip: { durationMs: 30_000 } }),
      ...many(5, { views: 1_000, clip: { durationMs: 75_000 } }),
    ];
    const insights = insightsOf(posts, IST);
    const length = insights.dimensions.find((dimension) => dimension.key === "length");
    expect(length?.finding).toMatchObject({
      key: "20-40",
      label: "20–40 s",
      posts: 5,
      restPosts: 5,
    });
    // Their usual is 1,500 views: 2,000 is 1.33 of it, 1,000 is 0.67, so twice as good.
    expect(length?.finding?.lift).toBeCloseTo(2, 2);
    expect(length?.finding?.sentence).toBe(
      "20–40 s clips got 2.0× the views of the rest, compared platform by platform (5 posts, against 5).",
    );
    expect(length?.groups.map((group) => [group.key, group.posts])).toEqual([
      ["20-40", 5],
      ["over-60", 5],
    ]);
    expect(insights.findings.map((finding) => finding.dimension)).toContain("length");
  });

  it("claims nothing from a group smaller than a handful, however good it looks", () => {
    const posts = [
      ...many(MIN_GROUP - 1, { views: 9_000, clip: { durationMs: 30_000 } }),
      ...many(6, { views: 1_000, clip: { durationMs: 75_000 } }),
    ];
    const length = insightsOf(posts, IST).dimensions.find((entry) => entry.key === "length");
    expect(length?.finding).toBeNull();
    expect(length?.note).toBe("Not enough posts to compare yet: a group and the rest each need 5.");
    expect(length?.groups.find((group) => group.key === "20-40")?.posts).toBe(MIN_GROUP - 1);
  });

  it("calls a small difference no difference", () => {
    const posts = [
      ...many(5, { views: 1_100, clip: { durationMs: 30_000 } }),
      ...many(5, { views: 1_000, clip: { durationMs: 75_000 } }),
    ];
    expect(1_100 / 1_000).toBeLessThan(CLEAR_LIFT);
    const length = insightsOf(posts, IST).dimensions.find((entry) => entry.key === "length");
    expect(length?.finding).toBeNull();
    expect(length?.note).toBe("No clear difference yet.");
  });

  it("does not let one viral post carry its whole group", () => {
    const posts = [
      ...many(4, { views: 500, clip: { durationMs: 30_000 } }),
      post({ views: 500_000, clip: { durationMs: 30_000 } }),
      ...many(5, { views: 1_000, clip: { durationMs: 75_000 } }),
    ];
    const length = insightsOf(posts, IST).dimensions.find((entry) => entry.key === "length");
    // By median the viral post's group did worse, and the other group is the finding.
    expect(length?.finding?.key).toBe("over-60");
  });

  it("finds the topic word that did better, from titles and hooks", () => {
    const posts = [
      ...many(5, { views: 3_000, clip: { title: "Saving tips for your first salary" } }),
      ...many(5, { views: 1_000, clip: { title: "Cricket stories from the village" } }),
    ];
    const topic = insightsOf(posts, IST).dimensions.find((entry) => entry.key === "topic");
    expect(topic?.finding).toMatchObject({ dimension: "topic", posts: 5, restPosts: 5 });
    expect(["saving", "tips", "first", "salary"]).toContain(topic?.finding?.key);
    expect(topic?.finding?.sentence).toMatch(/^Clips about “\w+” got 3\.0×/);
  });

  it("reads the time a post went out in the workspace's time zone", () => {
    const posts = [
      // 14:00 UTC is 19:30 in India: evening.
      ...many(5, { views: 3_000, postedAt: new Date("2026-10-01T14:00:00Z") }),
      // 03:00 UTC is 08:30 in India: morning.
      ...many(5, { views: 1_000, postedAt: new Date("2026-10-01T03:00:00Z") }),
    ];
    const time = insightsOf(posts, IST).dimensions.find((entry) => entry.key === "time");
    expect(time?.finding).toMatchObject({ key: "evening", label: "Evening (16–21)" });
    const elsewhere = insightsOf(posts, "UTC").dimensions.find((entry) => entry.key === "time");
    expect(elsewhere?.finding).toMatchObject({ key: "afternoon" });
  });

  it("reads no hour from a day typed without a time, but still its weekday", () => {
    const posts = [
      // Typed as a day: stored at noon UTC, which is no hour anyone posted at.
      ...many(5, { views: 3_000, timeKnown: false, postedAt: new Date("2026-10-03T12:00:00Z") }),
      ...many(5, { views: 1_000, timeKnown: false, postedAt: new Date("2026-10-05T12:00:00Z") }),
    ];
    const insights = insightsOf(posts, IST);
    const time = insights.dimensions.find((entry) => entry.key === "time");
    expect(time?.groups).toEqual([]);
    expect(time?.finding).toBeNull();
    // 3 October 2026 is a Saturday, 5 October a Monday.
    const days = insights.dimensions.find((entry) => entry.key === "day");
    expect(days?.finding).toMatchObject({ key: "weekend", posts: 5, restPosts: 5 });
  });

  it("names the best clips by views across their posts, and by engagement over enough views", () => {
    const viral = "clip-viral";
    const posts = [
      post({ views: 40_000, likes: 800, clip: { clipId: viral, title: "The big one" } }),
      post({ platform: "instagram", views: 8_000, clip: { clipId: viral, title: "The big one" } }),
      post({ views: 2_000, likes: 300, comments: 20, clip: { title: "Loved" } }),
      post({ views: 50, likes: 40, clip: { title: "Too few views to say" } }),
      ...many(3, { views: 1_000, likes: 10 }),
    ];
    const insights = insightsOf(posts, IST);
    expect(insights.topByViews[0]).toMatchObject({ clipId: viral, views: 48_000 });
    expect(insights.topByViews[0]?.posts).toHaveLength(2);
    expect(insights.topByEngagement[0]).toMatchObject({ title: "Loved" });
    expect(insights.topByEngagement[0]?.engagementRate).toBeCloseTo(0.16);
    expect(insights.topByEngagement.map((clip) => clip.title)).not.toContain(
      "Too few views to say",
    );
    expect(insights.platforms[0]).toEqual({ platform: "youtube", posts: 6, medianViews: 1_000 });
  });

  it("counts measured and entered views apart", () => {
    const posts = [...many(3, { viewsMeasured: true }), ...many(2, { viewsMeasured: false })];
    expect(insightsOf(posts, IST).totals).toMatchObject({ measured: 3, entered: 2 });
  });
});

describe("steeringSignalOf", () => {
  it("says nothing without enough posts, or enough clips", () => {
    const few = many(7, { views: 1_000 });
    expect(steeringSignalOf(few, insightsOf(few, IST))).toBeNull();
    const oneClip = many(10, { views: 1_000, clip: { clipId: "same" } });
    expect(steeringSignalOf(oneClip, insightsOf(oneClip, IST))).toBeNull();
  });

  it("says nothing when nothing stands out", () => {
    const flat = many(10, { views: 1_000 });
    expect(steeringSignalOf(flat, insightsOf(flat, IST))).toBeNull();
  });

  it("names the clips that did best, the length and the opening, within the contract", () => {
    const posts = [
      ...many(5, {
        views: 3_000,
        clip: { durationMs: 30_000, hook: "Kya aap ye galti karte ho?" },
      }),
      ...many(5, { views: 1_000, clip: { durationMs: 75_000, hook: "The plan for today" } }),
      post({
        views: 30_000,
        platform: "youtube",
        clip: {
          title: `  Salary aate hi   ye galti mat karna ${"x".repeat(200)}`,
          hook: "Salary aate hi?",
          excerpt: "y".repeat(900),
          durationMs: 30_000,
        },
      }),
    ];
    const signal = steeringSignalOf(posts, insightsOf(posts, IST));
    expect(PerformanceSignalSchema.safeParse(signal).success).toBe(true);
    expect(signal?.basis).toBe(11);
    expect(signal?.hits[0]).toMatchObject({ views: 30_000, platform: "youtube" });
    expect(signal?.hits[0]?.title.startsWith("Salary aate hi ye galti mat karna")).toBe(true);
    expect(signal?.hits[0]?.title.length).toBe(160);
    expect(signal?.hits[0]?.excerpt?.length).toBe(600);
    expect(signal?.hits.length).toBeLessThanOrEqual(5);
    expect(signal?.length).toEqual({ minMs: 20_000, maxMs: 40_000, posts: 6 });
    expect(signal?.hook).toEqual({ style: "question", posts: 6 });

    expect(describeSignal(signal ?? { basis: 1, hits: [] })).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Moments like “Salary aate hi/),
        "Clips of 20–40 s (6 posts).",
        "Opens with a question (6 posts).",
      ]),
    );
  });
});
