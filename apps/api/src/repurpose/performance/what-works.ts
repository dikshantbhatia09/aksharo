import type { HookStyle, PerformanceSignal } from "@montaj/repurpose-contracts";

import { ENGAGEMENT_MIN_VIEWS, engagementRate } from "./metrics.js";
import { PLATFORM_LABELS } from "./post-links.js";
import { contentWords, hookStyle } from "./words.js";

import type { PostPlatform } from "./post-links.js";

/**
 * "What works" (2026-10-05): which clips did best, and what they share - the
 * maths, with no database in it.
 *
 * **Compared platform by platform.** A YouTube Short and a LinkedIn video
 * live on different scales, so each post's views are read against the
 * workspace's usual views on that platform (its median there): 2.0 is twice
 * what this workspace usually gets on that platform. Every comparison is of
 * those ratios, by median, so one viral post cannot carry a whole group.
 *
 * **Nothing from a handful.** Nothing at all is said from fewer than
 * {@link MIN_POSTS} posts with views. A group is compared only when it and the
 * rest each have {@link MIN_GROUP} posts, and a difference is called a finding
 * only when the group's median is at least {@link CLEAR_LIFT} times the
 * rest's. Every group is shown with its number of posts, finding or not.
 *
 * **What a clip shares** is read from facts Aksharo has, never inferred about
 * people: the clip's length, how its hook opens (`words.ts`), its layout, its
 * language, when the post went out, and the content words its title and hook
 * share with other clips.
 */

/** Nothing is said from fewer posts with views than this. */
export const MIN_POSTS = 5;
/** A group - and the rest it is compared with - needs this many posts. */
export const MIN_GROUP = 5;
/** A group is clearly better when its median is at least this times the rest's. */
export const CLEAR_LIFT = 1.25;
/** How many clips each "best" list names. */
export const TOP_CLIPS = 5;
/** Topic words listed per view, most posted first. */
const TOPIC_WORDS_SHOWN = 6;

/** The steering signal needs this many posts with views... */
export const STEERING_MIN_POSTS = 8;
/** ...across this many clips... */
export const STEERING_MIN_CLIPS = 4;
/** ...and names a clip as a hit when its best post did this much better than usual. */
export const HIT_MIN_RELATIVE = 1.5;
const HIT_EXCERPT_CHARS = 600;

export interface ClipFacts {
  readonly clipId: string;
  readonly runId: string;
  readonly title: string;
  /** The on-screen hook, when the clip has one. */
  readonly hook: string | null;
  readonly excerpt: string;
  readonly durationMs: number;
}

export interface PostFacts {
  readonly postId: string;
  readonly clip: ClipFacts;
  readonly platform: PostPlatform;
  readonly url: string | null;
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
  /** Whether the views were measured rather than typed in; null without views. */
  readonly viewsMeasured: boolean | null;
  /** When it went out, when that is known: what "Time posted" and "Day posted" read. */
  readonly postedAt: Date | null;
  /** Whether `postedAt` has the time of day, not just the day: only then is "Time posted" read. */
  readonly timeKnown: boolean;
  /** When it went out, or was recorded when that is not known: what a window is cut by. */
  readonly at: Date;
  readonly layout: "single" | "stacked" | "fit" | null;
  /** The language the post's words are in (a dub's, else the clip's). */
  readonly language: string | null;
}

export type DimensionKey = "length" | "hook" | "topic" | "layout" | "language" | "time" | "day";

export interface GroupView {
  readonly key: string;
  readonly label: string;
  /** Posts with views in the group. */
  readonly posts: number;
  /** Their median views against their platform's usual; null without any. */
  readonly medianRelative: number | null;
  /** Their median engagement rate, over posts with enough views to have one. */
  readonly medianEngagement: number | null;
}

export interface FindingView {
  readonly dimension: DimensionKey;
  readonly key: string;
  readonly label: string;
  /** The group's median over the rest's. */
  readonly lift: number;
  readonly posts: number;
  readonly restPosts: number;
  readonly sentence: string;
}

export interface DimensionView {
  readonly key: DimensionKey;
  readonly label: string;
  readonly groups: readonly GroupView[];
  readonly finding: FindingView | null;
  /** Why there is no finding, when there is none. */
  readonly note: string | null;
}

export interface TopClipView {
  readonly clipId: string;
  readonly runId: string;
  readonly title: string;
  /** Views across its posts. */
  readonly views: number;
  /** Likes, comments and shares per view across its posts with enough views; null without. */
  readonly engagementRate: number | null;
  /** Its best post against that platform's usual. */
  readonly bestRelative: number | null;
  readonly posts: readonly {
    readonly postId: string;
    readonly platform: PostPlatform;
    readonly views: number | null;
    readonly url: string | null;
  }[];
}

export interface PlatformView {
  readonly platform: PostPlatform;
  readonly posts: number;
  readonly medianViews: number;
}

export interface Insights {
  readonly totals: {
    /** Every post in the window, with numbers or not. */
    readonly posts: number;
    readonly withViews: number;
    /** Posts whose views were measured, and whose were typed in. */
    readonly measured: number;
    readonly entered: number;
    readonly clips: number;
  };
  /** At least {@link MIN_POSTS} posts with views: anything else is said. */
  readonly enough: boolean;
  readonly platforms: readonly PlatformView[];
  readonly topByViews: readonly TopClipView[];
  readonly topByEngagement: readonly TopClipView[];
  readonly dimensions: readonly DimensionView[];
  readonly findings: readonly FindingView[];
}

// ---------------------------------------------------------------------------
// Small statistics
// ---------------------------------------------------------------------------

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted.at(middle) ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted.at(middle - 1) ?? 0) + upper) / 2;
}

/** Each post's views against its platform's median, for posts with views. */
export function relativeViews(posts: readonly PostFacts[]): Map<string, number> {
  const byPlatform = new Map<PostPlatform, number[]>();
  for (const post of posts) {
    if (post.views === null) continue;
    const list = byPlatform.get(post.platform) ?? [];
    list.push(post.views);
    byPlatform.set(post.platform, list);
  }
  const usual = new Map<PostPlatform, number>();
  for (const [platform, views] of byPlatform) usual.set(platform, median(views) ?? 0);
  const relative = new Map<string, number>();
  for (const post of posts) {
    if (post.views === null) continue;
    const base = usual.get(post.platform) ?? 0;
    // A platform whose usual is 0 views says nothing relative about any post on it.
    if (base > 0) relative.set(post.postId, post.views / base);
  }
  return relative;
}

function rateOf(post: PostFacts): number | null {
  return engagementRate(post);
}

/** `1.6×` as a person reads it: one decimal. */
function times(lift: number): string {
  return `${(Math.round(lift * 10) / 10).toFixed(1)}×`;
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

interface Bucket {
  readonly key: string;
  readonly label: string;
  /** The subject of a finding's sentence: "20-40 s clips". */
  readonly subject: string;
}

export const LENGTH_BANDS: readonly {
  readonly key: string;
  readonly minMs: number;
  readonly maxMs: number;
  readonly label: string;
}[] = [
  { key: "under-20", minMs: 0, maxMs: 20_000, label: "Under 20 s" },
  { key: "20-40", minMs: 20_000, maxMs: 40_000, label: "20–40 s" },
  { key: "40-60", minMs: 40_000, maxMs: 60_000, label: "40–60 s" },
  { key: "over-60", minMs: 60_000, maxMs: 180_000, label: "Over 60 s" },
];

const HOOK_LABELS: Readonly<Record<HookStyle, { label: string; subject: string }>> = {
  question: { label: "Opens with a question", subject: "Clips that open with a question" },
  number: { label: "Opens with a number", subject: "Clips that open with a number" },
  you: { label: "Speaks to the viewer", subject: "Clips that speak to the viewer from the start" },
  statement: { label: "Opens with a statement", subject: "Clips that open with a statement" },
};

const TIMES_OF_DAY: readonly { key: string; from: number; to: number; label: string }[] = [
  { key: "morning", from: 5, to: 11, label: "Morning (5–11)" },
  { key: "afternoon", from: 11, to: 16, label: "Afternoon (11–16)" },
  { key: "evening", from: 16, to: 21, label: "Evening (16–21)" },
  { key: "night", from: 21, to: 29, label: "Night (21–5)" },
];

function lengthBucket(post: PostFacts): Bucket | null {
  const ms = post.clip.durationMs;
  const band = LENGTH_BANDS.find((entry) => ms >= entry.minMs && ms < entry.maxMs);
  return band === undefined
    ? null
    : { key: band.key, label: band.label, subject: `${band.label} clips` };
}

function hookBucket(post: PostFacts): Bucket {
  const style = hookStyle(post.clip.hook ?? post.clip.title);
  // eslint-disable-next-line security/detect-object-injection -- a style from the closed union
  const words = HOOK_LABELS[style];
  return { key: style, label: words.label, subject: words.subject };
}

function layoutBucket(post: PostFacts): Bucket | null {
  if (post.layout === "single") {
    return { key: "single", label: "One speaker", subject: "Clips framed on one speaker" };
  }
  if (post.layout === "stacked") {
    return {
      key: "stacked",
      label: "Two speakers, stacked",
      subject: "Clips with two speakers one above the other",
    };
  }
  if (post.layout === "fit") {
    return {
      key: "fit",
      label: "Canvas fit",
      subject: "Clips with canvas fit presentation",
    };
  }
  return null;
}

function languageName(tag: string): string {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    return names.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

function languageBucket(post: PostFacts): Bucket | null {
  if (post.language === null || post.language.trim() === "") return null;
  const name = languageName(post.language);
  return { key: post.language, label: name, subject: `Clips in ${name}` };
}

/** The hour and weekday of an instant in a time zone; null for an unknown zone. */
function localTime(at: Date, timeZone: string): { hour: number; weekday: string } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(at);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
    return Number.isFinite(hour) ? { hour, weekday } : null;
  } catch {
    return null;
  }
}

function timeBucket(post: PostFacts, timeZone: string): Bucket | null {
  if (post.postedAt === null || !post.timeKnown) return null;
  const local = localTime(post.postedAt, timeZone);
  if (local === null) return null;
  const hour = local.hour < 5 ? local.hour + 24 : local.hour;
  const slot = TIMES_OF_DAY.find((entry) => hour >= entry.from && hour < entry.to);
  return slot === undefined
    ? null
    : { key: slot.key, label: slot.label, subject: `Posts in the ${slot.key}` };
}

function dayBucket(post: PostFacts, timeZone: string): Bucket | null {
  if (post.postedAt === null) return null;
  const local = localTime(post.postedAt, timeZone);
  if (local === null) return null;
  return local.weekday === "Sat" || local.weekday === "Sun"
    ? { key: "weekend", label: "Weekend", subject: "Posts at the weekend" }
    : { key: "weekday", label: "Weekday", subject: "Posts on weekdays" };
}

// ---------------------------------------------------------------------------
// Comparing groups
// ---------------------------------------------------------------------------

interface Entry {
  readonly post: PostFacts;
  readonly relative: number;
  readonly engagement: number | null;
}

function groupView(key: string, label: string, entries: readonly Entry[]): GroupView {
  return {
    key,
    label,
    posts: entries.length,
    medianRelative: median(entries.map((entry) => entry.relative)),
    medianEngagement: median(
      entries.map((entry) => entry.engagement).filter((rate): rate is number => rate !== null),
    ),
  };
}

function sentence(subject: string, lift: number, posts: number, restPosts: number): string {
  return (
    `${subject} got ${times(lift)} the views of the rest, compared platform by platform ` +
    `(${String(posts)} posts, against ${String(restPosts)}).`
  );
}

/** The finding for a group against the rest, when it is clearly better. */
function findingOf(
  dimension: DimensionKey,
  bucket: Bucket,
  inside: readonly Entry[],
  rest: readonly Entry[],
): FindingView | null {
  if (inside.length < MIN_GROUP || rest.length < MIN_GROUP) return null;
  const mine = median(inside.map((entry) => entry.relative));
  const theirs = median(rest.map((entry) => entry.relative));
  if (mine === null || theirs === null || theirs <= 0) return null;
  const lift = mine / theirs;
  if (lift < CLEAR_LIFT) return null;
  return {
    dimension,
    key: bucket.key,
    label: bucket.label,
    lift: Math.round(lift * 100) / 100,
    posts: inside.length,
    restPosts: rest.length,
    sentence: sentence(bucket.subject, lift, inside.length, rest.length),
  };
}

const NOT_ENOUGH = `Not enough posts to compare yet: a group and the rest each need ${String(MIN_GROUP)}.`;

function noteFor(groups: readonly GroupView[], total: number): string {
  if (groups.length < 2) return "Every post so far falls in one group: nothing to compare yet.";
  // A comparison needs one group of a handful against a rest of a handful.
  const comparable = groups.some(
    (group) => group.posts >= MIN_GROUP && total - group.posts >= MIN_GROUP,
  );
  return comparable ? "No clear difference yet." : NOT_ENOUGH;
}

function compareBy(
  key: DimensionKey,
  label: string,
  entries: readonly Entry[],
  bucketOf: (post: PostFacts) => Bucket | null,
): DimensionView {
  const buckets = new Map<string, { bucket: Bucket; entries: Entry[] }>();
  const placed: Entry[] = [];
  for (const entry of entries) {
    const bucket = bucketOf(entry.post);
    if (bucket === null) continue;
    const held = buckets.get(bucket.key) ?? { bucket, entries: [] };
    held.entries.push(entry);
    buckets.set(bucket.key, held);
    placed.push(entry);
  }
  const groups = [...buckets.values()].map((held) =>
    groupView(held.bucket.key, held.bucket.label, held.entries),
  );
  let finding: FindingView | null = null;
  for (const held of buckets.values()) {
    const inside = new Set(held.entries);
    const rest = placed.filter((entry) => !inside.has(entry));
    const candidate = findingOf(key, held.bucket, held.entries, rest);
    if (candidate !== null && (finding === null || candidate.lift > finding.lift)) {
      finding = candidate;
    }
  }
  return {
    key,
    label,
    groups: groups.sort((a, b) => b.posts - a.posts || a.label.localeCompare(b.label)),
    finding,
    note: finding === null ? noteFor(groups, placed.length) : null,
  };
}

/** Topic: the content words clips' titles and hooks share, each compared with the rest. */
function compareTopics(entries: readonly Entry[]): DimensionView {
  const wordsOf = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const words = contentWords(`${entry.post.clip.title} ${entry.post.clip.hook ?? ""}`);
    wordsOf.set(entry.post.postId, words);
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const shared = [...counts]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const groups: GroupView[] = [];
  let finding: FindingView | null = null;
  for (const [word] of shared) {
    const inside = entries.filter((entry) => wordsOf.get(entry.post.postId)?.has(word) === true);
    const rest = entries.filter((entry) => wordsOf.get(entry.post.postId)?.has(word) !== true);
    if (groups.length < TOPIC_WORDS_SHOWN) groups.push(groupView(word, word, inside));
    const bucket = { key: word, label: word, subject: `Clips about “${word}”` };
    const candidate = findingOf("topic", bucket, inside, rest);
    if (candidate !== null && (finding === null || candidate.lift > finding.lift)) {
      finding = candidate;
    }
  }
  return {
    key: "topic",
    label: "Topic",
    groups,
    finding,
    note:
      finding !== null
        ? null
        : shared.length === 0
          ? "No two clips share a topic word yet."
          : entries.length < 2 * MIN_GROUP
            ? NOT_ENOUGH
            : "No clear difference yet.",
  };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

function topClip(clipId: string, posts: readonly PostFacts[], relative: Map<string, number>) {
  const first = posts[0];
  const views = posts.reduce((sum, post) => sum + (post.views ?? 0), 0);
  const rated = posts.filter((post) => rateOf(post) !== null);
  const ratedViews = rated.reduce((sum, post) => sum + (post.views ?? 0), 0);
  const engaged = rated.reduce(
    (sum, post) => sum + (post.likes ?? 0) + (post.comments ?? 0) + (post.shares ?? 0),
    0,
  );
  const relatives = posts
    .map((post) => relative.get(post.postId))
    .filter((value): value is number => value !== undefined);
  return {
    clipId,
    runId: first?.clip.runId ?? "",
    title: first?.clip.title ?? "",
    views,
    engagementRate: ratedViews >= ENGAGEMENT_MIN_VIEWS ? engaged / ratedViews : null,
    bestRelative: relatives.length === 0 ? null : Math.max(...relatives),
    posts: posts.map((post) => ({
      postId: post.postId,
      platform: post.platform,
      views: post.views,
      url: post.url,
    })),
  } satisfies TopClipView;
}

/** Everything "What works" says about a workspace's posts. */
export function insightsOf(posts: readonly PostFacts[], timeZone: string): Insights {
  const relative = relativeViews(posts);
  const withViews = posts.filter((post) => post.views !== null);
  const entries: Entry[] = posts.flatMap((post) => {
    const value = relative.get(post.postId);
    return value === undefined ? [] : [{ post, relative: value, engagement: rateOf(post) }];
  });
  const enough = withViews.length >= MIN_POSTS;

  const byPlatform = new Map<PostPlatform, number[]>();
  for (const post of withViews) {
    const list = byPlatform.get(post.platform) ?? [];
    list.push(post.views ?? 0);
    byPlatform.set(post.platform, list);
  }
  const platforms = [...byPlatform]
    .map(([platform, views]) => ({
      platform,
      posts: views.length,
      medianViews: median(views) ?? 0,
    }))
    .sort((a, b) => b.posts - a.posts || a.platform.localeCompare(b.platform));

  const byClip = new Map<string, PostFacts[]>();
  for (const post of withViews) {
    const list = byClip.get(post.clip.clipId) ?? [];
    list.push(post);
    byClip.set(post.clip.clipId, list);
  }
  const clips = [...byClip].map(([clipId, list]) => topClip(clipId, list, relative));
  const topByViews = enough ? [...clips].sort((a, b) => b.views - a.views).slice(0, TOP_CLIPS) : [];
  const topByEngagement = enough
    ? clips
        .filter((clip) => clip.engagementRate !== null)
        .sort((a, b) => (b.engagementRate ?? 0) - (a.engagementRate ?? 0))
        .slice(0, TOP_CLIPS)
    : [];

  const dimensions: DimensionView[] = enough
    ? [
        compareBy("length", "Length", entries, lengthBucket),
        compareBy("hook", "Opening", entries, hookBucket),
        compareTopics(entries),
        compareBy("layout", "Layout", entries, layoutBucket),
        compareBy("language", "Language", entries, languageBucket),
        compareBy("time", "Time posted", entries, (post) => timeBucket(post, timeZone)),
        compareBy("day", "Day posted", entries, (post) => dayBucket(post, timeZone)),
      ]
    : [];

  return {
    totals: {
      posts: posts.length,
      withViews: withViews.length,
      measured: withViews.filter((post) => post.viewsMeasured === true).length,
      entered: withViews.filter((post) => post.viewsMeasured === false).length,
      clips: new Set(posts.map((post) => post.clip.clipId)).size,
    },
    enough,
    platforms,
    topByViews,
    topByEngagement,
    dimensions,
    findings: dimensions.flatMap((dimension) =>
      dimension.finding === null ? [] : [dimension.finding],
    ),
  };
}

// ---------------------------------------------------------------------------
// Steering the next picks
// ---------------------------------------------------------------------------

function trimmed(value: string | null | undefined, max: number): string | undefined {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return undefined;
  return text.length <= max ? text : text.slice(0, max).trimEnd();
}

/**
 * What `ai.highlights` is told about this workspace's posts, or null when
 * they are too few to say anything (fewer than {@link STEERING_MIN_POSTS}
 * posts with views, or fewer than {@link STEERING_MIN_CLIPS} clips), or say
 * nothing clear.
 */
export function steeringSignalOf(
  posts: readonly PostFacts[],
  insights: Insights,
): PerformanceSignal | null {
  const relative = relativeViews(posts);
  const measured = posts.filter((post) => relative.has(post.postId));
  const clips = new Set(measured.map((post) => post.clip.clipId));
  if (measured.length < STEERING_MIN_POSTS || clips.size < STEERING_MIN_CLIPS) return null;

  // Each clip by its best post, against that platform's usual.
  const best = new Map<string, { post: PostFacts; relative: number }>();
  for (const post of measured) {
    const value = relative.get(post.postId) ?? 0;
    const held = best.get(post.clip.clipId);
    if (held === undefined || value > held.relative) {
      best.set(post.clip.clipId, { post, relative: value });
    }
  }
  const hits = [...best.values()]
    .filter((entry) => entry.relative >= HIT_MIN_RELATIVE)
    .sort((a, b) => b.relative - a.relative || (b.post.views ?? 0) - (a.post.views ?? 0))
    .slice(0, 5)
    .map(({ post }) => {
      const hook = trimmed(post.clip.hook, 500);
      const excerpt = trimmed(post.clip.excerpt, HIT_EXCERPT_CHARS);
      return {
        title: trimmed(post.clip.title, 160) ?? "A clip",
        ...(hook === undefined ? {} : { hook }),
        ...(excerpt === undefined ? {} : { excerpt }),
        views: post.views ?? 0,
        platform: post.platform,
      };
    });

  const lengthFinding = insights.findings.find((finding) => finding.dimension === "length");
  const band = LENGTH_BANDS.find((entry) => entry.key === lengthFinding?.key);
  const hookFinding = insights.findings.find((finding) => finding.dimension === "hook");

  if (hits.length === 0 && band === undefined && hookFinding === undefined) return null;
  return {
    basis: measured.length,
    hits,
    ...(band === undefined || lengthFinding === undefined
      ? {}
      : {
          length: {
            minMs: band.minMs,
            maxMs: Math.min(180_000, band.maxMs),
            posts: lengthFinding.posts,
          },
        }),
    ...(hookFinding === undefined
      ? {}
      : { hook: { style: hookFinding.key as HookStyle, posts: hookFinding.posts } }),
  };
}

/** A sentence per part of a signal, for the page: what the next picks lean toward. */
export function describeSignal(signal: PerformanceSignal): string[] {
  const lines: string[] = [];
  for (const hit of signal.hits) {
    const platform = PLATFORM_LABELS[hit.platform];
    lines.push(
      `Moments like “${hit.title}” (${hit.views.toLocaleString("en-US")} views on ${platform}).`,
    );
  }
  const length = signal.length;
  if (length !== undefined) {
    const band = LENGTH_BANDS.find(
      (entry) => entry.minMs === length.minMs && entry.maxMs === length.maxMs,
    );
    const label = band?.label.toLowerCase() ?? "this length";
    lines.push(`Clips of ${label} (${String(length.posts)} posts).`);
  }
  if (signal.hook !== undefined) {
    const words = HOOK_LABELS[signal.hook.style];
    lines.push(`${words.label} (${String(signal.hook.posts)} posts).`);
  }
  return lines;
}
