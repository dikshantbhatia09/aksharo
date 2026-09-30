/**
 * Every sentence the pages say about how clips did (2026-10-05), in one place
 * so the beginner-safety sweep (`FORBIDDEN_USER_FACING_WORDS`: no tool names,
 * no "queue") covers all of it. Numbers read by Aksharo are "measured", from
 * the platform they were read from; numbers a person typed are "entered":
 * the page never lets one pass for the other.
 */
import { isApiError } from "@montaj/api-client";

import type { ClipPost, Metric, MetricSource, MetricView, PostPlatform } from "./use-performance";

export const PERFORMANCE_COPY = Object.freeze({
  section: "How it did",
  addButton: "I posted this",
  addTitle: "Add a post of this clip",
  linkLabel: "Link to the post",
  linkHint: "From YouTube, Instagram, TikTok, LinkedIn, X, Facebook or Threads.",
  linkPlaceholder: "https://www.youtube.com/shorts/…",
  shapeLabel: "Shape posted",
  languageLabel: "Language",
  ownLanguage: "The clip's own words",
  postedLabel: "Day it went out (optional)",
  save: "Add post",
  saving: "Adding…",
  cancel: "Cancel",
  numbersButton: "Enter numbers",
  numbersTitle: "Numbers from the app",
  numbersHint: "Type what the platform shows. Leave out what you do not have.",
  saveNumbers: "Save numbers",
  savingNumbers: "Saving…",
  numbersEmpty: "Type at least one number.",
  numbersInvalid: "Numbers are whole, and 0 or more.",
  linkEmpty: "Paste the link to the post.",
  viewPost: "View post",
  remove: "Remove",
  removeTitle: "Stop following this post?",
  removeDescription: "Its numbers here go with it. The post itself stays where you posted it.",
  removeConfirm: "Remove post",
  noNumbersYet: "No numbers yet.",
  metric: Object.freeze({
    views: "views",
    likes: "likes",
    comments: "comments",
    shares: "shares",
  } satisfies Record<Metric, string>),
  metricLabel: Object.freeze({
    views: "Views",
    likes: "Likes",
    comments: "Comments",
    shares: "Shares",
  } satisfies Record<Metric, string>),
  engagement: (percent: string): string => `${percent} engagement`,
  postedOn: (day: string): string => `Posted ${day}`,
  readNext: (when: string): string => `Read again ${when}.`,
  readSoon: "Being read.",
  readsOff: "Numbers are not read by themselves right now: type them in when you check.",
  summary: (posts: number, views: string | null): string =>
    `${String(posts)} ${posts === 1 ? "post" : "posts"}${views === null ? "" : ` · ${views} views`}`,
});

/** The workspace's What works page. */
export const WHAT_WORKS_COPY = Object.freeze({
  eyebrow: "Clips pipeline",
  title: "What works",
  description:
    "Which of your posted clips did best, and what they have in common. Numbers are measured from each platform where Aksharo can read them, and entered by you where it cannot.",
  runsLink: "Runs",
  windowLabel: "Posts from",
  windows: Object.freeze([
    { days: 30, label: "Last 30 days" },
    { days: 90, label: "Last 90 days" },
    { days: 365, label: "Last year" },
  ]),
  off: Object.freeze({
    title: "What works is not on for this workspace yet",
    description:
      "It follows your posted clips, reads how each one did, and tells you what the best ones share.",
  }),
  loadError: "What works could not be loaded. Try again in a moment.",
  totals: (
    posts: number,
    clips: number,
    withViews: number,
    measured: number,
    entered: number,
  ): string =>
    `${String(posts)} ${posts === 1 ? "post" : "posts"} of ${String(clips)} ${clips === 1 ? "clip" : "clips"}; ` +
    `${String(withViews)} with views (${String(measured)} measured, ${String(entered)} entered).`,
  notEnough: Object.freeze({
    title: "Not enough to go on yet",
    description: (minPosts: number): string =>
      `Post a few clips, and add numbers where Aksharo cannot read them. Nothing here is said from fewer than ${String(minPosts)} posts with views.`,
  }),
  steeringHeading: "What your next picks lean toward",
  steeringFootnote: (basis: number): string =>
    `From ${String(basis)} posts with views. A small nudge only: the topic, clip length and skipped parts you choose always come first.`,
  steeringOff: (minPosts: number): string =>
    `Your next runs are picked as usual until ${String(minPosts)} posts on at least 4 clips have views.`,
  mostViewed: "Most viewed",
  mostEngaging: "Most engaging",
  noEngagement: "No clip has enough views with likes, comments or shares yet.",
  sharedHeading: "What they share",
  sharedIntro: (minGroup: number, lift: number): string =>
    `Each group is compared with the rest, platform by platform: 1.0× is your usual. A difference is only called one with at least ${String(minGroup)} posts on each side and ${lift.toFixed(2)}× or more.`,
  timesIn: (zone: string): string => `Times are read in ${zone}.`,
  usualHeading: "Your usual views",
  groupColumns: Object.freeze({
    group: "Group",
    posts: "Posts",
    relative: "Views vs usual",
    engagement: "Engagement",
  }),
  views: (count: string): string => `${count} views`,
  usual: (views: string, posts: number): string =>
    `${views} views (${String(posts)} ${posts === 1 ? "post" : "posts"})`,
  openClip: "Open clip",
});

/** "views", as a number is followed by it. */
export function metricWord(metric: Metric): string {
  // eslint-disable-next-line security/detect-object-injection -- a metric from the closed union
  return PERFORMANCE_COPY.metric[metric];
}

/** "Views", as a field is labelled. */
export function metricLabel(metric: Metric): string {
  // eslint-disable-next-line security/detect-object-injection -- a metric from the closed union
  return PERFORMANCE_COPY.metricLabel[metric];
}

/** Refusals a change can meet, as sentences a person can act on. */
const ERROR_COPY: Readonly<Record<string, string>> = Object.freeze({
  "performance/link_invalid":
    "That is not a link to a post. Copy the post's link and paste it here.",
  "performance/link_unsupported":
    "Aksharo cannot follow posts on that site. Use a link from YouTube, Instagram, TikTok, LinkedIn, X, Facebook or Threads.",
  "performance/link_not_a_post": "That link is not a post. Open the post itself and copy its link.",
  "performance/link_short":
    "That is a short link. Open it, then copy the full address of the post.",
  "performance/post_exists": "This post is already recorded.",
  "performance/shape_unknown": "This clip was not made in that shape.",
  "performance/language_unknown": "This clip has no dubbed version in that language.",
  "performance/date_invalid": "That day is in the future. Give the day it went out.",
  "performance/numbers_empty": "Type at least one number.",
  "performance/too_many_posts": "This clip has as many posts as it can carry. Remove one first.",
  "performance/post_not_removable":
    "A post made from Aksharo is followed from where it was posted. Delete it there to stop following it.",
  "performance/post_not_found": "That post is gone. Refresh the page.",
  "performance/clip_not_found": "That clip is gone. Refresh the page.",
  "performance/not_available": "This is not switched on for your workspace.",
});

const FALLBACK = "That did not work. Try again in a moment.";

/** The one sentence a refused change may show. */
export function describePerformanceError(error: unknown): string {
  if (!isApiError(error)) return FALLBACK;
  if (error.status === 429) return "Too many changes at once. Wait a minute, then try again.";
  return Object.hasOwn(ERROR_COPY, error.code) ? (ERROR_COPY[error.code] ?? FALLBACK) : FALLBACK;
}

/** 950, 12.4k, 1.5M: a count as a person says it. */
export function compactCount(value: number): string {
  const round = (number: number): string => {
    const text = number.toFixed(1);
    return text.endsWith(".0") ? text.slice(0, -2) : text;
  };
  // 999,950 rounds to "1000.0k": it is a million already.
  if (value >= 999_950) return `${round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${round(value / 1_000)}k`;
  return String(value);
}

/** 4.2%, from 0.042. */
export function percent(rate: number): string {
  const value = rate * 100;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function ago(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${String(days)} ${days === 1 ? "day" : "days"} ago`;
  return `on ${day(iso)}`;
}

/** "in 5 min", "in 3 h", "in 2 days"; "soon" for a time already past. */
export function until(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at <= now) return "soon";
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 60) return `in ${String(Math.max(1, minutes))} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${String(hours)} h`;
  const days = Math.round(hours / 24);
  return `in ${String(days)} ${days === 1 ? "day" : "days"}`;
}

/** "3 Oct". */
export function day(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

const PLATFORM_NAMES: Readonly<Record<PostPlatform, string>> = Object.freeze({
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  x: "X",
  facebook: "Facebook",
  threads: "Threads",
});

export function platformName(platform: PostPlatform): string {
  // eslint-disable-next-line security/detect-object-injection -- a closed union
  return PLATFORM_NAMES[platform];
}

/** Where a number came from, in words: never a tool's name. */
function sourceWords(source: MetricSource, platform: PostPlatform): string {
  return source === "person" ? "entered" : `measured from ${platformName(platform)}`;
}

function list(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1] ?? ""}`;
}

/**
 * Where each number came from and when, one clause per source and time:
 * "Views measured from YouTube 2 h ago · likes and comments entered 3 days ago."
 */
export function provenance(post: ClipPost, now: number = Date.now()): string {
  const groups = new Map<string, { metrics: Metric[]; words: string; when: string }>();
  for (const metric of ["views", "likes", "comments", "shares"] as const) {
    // eslint-disable-next-line security/detect-object-injection -- a metric from the closed list
    const view: MetricView | null = post.numbers[metric];
    if (view === null) continue;
    const words = sourceWords(view.source, post.platform);
    const when = ago(view.at, now);
    const key = `${words}|${when}`;
    const held = groups.get(key) ?? { metrics: [], words, when };
    held.metrics.push(metric);
    groups.set(key, held);
  }
  const clauses = [...groups.values()].map((group, index) => {
    const names = list(group.metrics.map(metricWord));
    const subject = index === 0 ? names.charAt(0).toUpperCase() + names.slice(1) : names;
    return `${subject} ${group.words} ${group.when}`;
  });
  return clauses.length === 0 ? "" : `${clauses.join(" · ")}.`;
}

/**
 * How the post's numbers are kept up to date, in one line; null when there is
 * nothing to say. `readsEnabled` false: this server reads nothing by itself
 * right now, so a post waiting to be read says so rather than "Being read".
 */
export function readingLine(
  post: ClipPost,
  now: number = Date.now(),
  readsEnabled = true,
): string | null {
  if (post.reading.state === "reading") {
    if (!readsEnabled) return PERFORMANCE_COPY.readsOff;
    return post.reading.nextAt === null || Date.parse(post.reading.nextAt) <= now
      ? PERFORMANCE_COPY.readSoon
      : PERFORMANCE_COPY.readNext(until(post.reading.nextAt, now));
  }
  return post.reading.note;
}

/** Every fixed sentence here, for the safety sweep. */
export function allPerformanceSentences(): string[] {
  const fixed = Object.values(PERFORMANCE_COPY).flatMap((value) =>
    typeof value === "string"
      ? [value]
      : typeof value === "function"
        ? []
        : Object.values(value as Record<string, string>),
  );
  return [
    ...fixed,
    PERFORMANCE_COPY.engagement("4.2%"),
    PERFORMANCE_COPY.postedOn("3 Oct"),
    PERFORMANCE_COPY.readNext("in 3 h"),
    PERFORMANCE_COPY.summary(3, "14.2k"),
    ...Object.values(ERROR_COPY),
    FALLBACK,
    WHAT_WORKS_COPY.eyebrow,
    WHAT_WORKS_COPY.title,
    WHAT_WORKS_COPY.description,
    WHAT_WORKS_COPY.off.title,
    WHAT_WORKS_COPY.off.description,
    WHAT_WORKS_COPY.loadError,
    WHAT_WORKS_COPY.totals(12, 5, 9, 6, 3),
    WHAT_WORKS_COPY.notEnough.title,
    WHAT_WORKS_COPY.notEnough.description(5),
    WHAT_WORKS_COPY.steeringHeading,
    WHAT_WORKS_COPY.steeringFootnote(11),
    WHAT_WORKS_COPY.steeringOff(8),
    WHAT_WORKS_COPY.sharedIntro(5, 1.25),
    WHAT_WORKS_COPY.timesIn("Asia/Kolkata"),
    WHAT_WORKS_COPY.noEngagement,
    ...WHAT_WORKS_COPY.windows.map((entry) => entry.label),
    ...Object.values(WHAT_WORKS_COPY.groupColumns),
  ];
}
