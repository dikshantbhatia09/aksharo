import { z } from "zod";

/**
 * A post's numbers (2026-10-05): the four every source can say - views, likes,
 * comments, shares - and where each came from.
 *
 * Snapshots are the record (`clip_post_snapshots`); `clip_posts.latest` is a
 * cache of them, per number: the newest value of each, with its source and the
 * moment it was read or typed. Per number, because sources say different
 * things: the YouTube page says views and nothing else, and a person may type
 * the likes and comments next to them. So a post can honestly read "12,400
 * views (measured 2 h ago) · 830 likes (entered 3 days ago)".
 */

export const METRICS = ["views", "likes", "comments", "shares"] as const;
export type Metric = (typeof METRICS)[number];

export const METRIC_SOURCES = ["postiz", "youtube_page", "person"] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];

/** A count kept as a Postgres `integer`: a post past two billion views is recorded at the cap. */
export const MAX_COUNT = 2_147_483_647;

/**
 * Engagement is only a rate over enough views to mean something: 3 likes on 5
 * views is not a 60 % engagement rate anyone should act on.
 */
export const ENGAGEMENT_MIN_VIEWS = 100;

const entrySchema = z.object({
  value: z.int().min(0).max(MAX_COUNT),
  source: z.enum(METRIC_SOURCES),
  at: z.iso.datetime({ offset: true }),
});
export type LatestEntry = z.infer<typeof entrySchema>;

/** `clip_posts.latest`. */
export const latestSchema = z.object({
  views: entrySchema.optional(),
  likes: entrySchema.optional(),
  comments: entrySchema.optional(),
  shares: entrySchema.optional(),
});
export type Latest = z.infer<typeof latestSchema>;

/** One set of numbers, as a snapshot records it. */
export interface Counts {
  readonly views?: number | null;
  readonly likes?: number | null;
  readonly comments?: number | null;
  readonly shares?: number | null;
}

/** A count as stored: a whole number from 0 to {@link MAX_COUNT}, or null. */
export function clampCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  return Math.min(MAX_COUNT, Math.floor(value));
}

/** The stored cache, entry by entry: one that does not read is dropped, not the rest. */
export function readLatest(value: unknown): Latest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const latest: { [K in Metric]?: LatestEntry } = {};
  for (const metric of METRICS) {
    // eslint-disable-next-line security/detect-object-injection -- a metric name from the closed list above
    const parsed = entrySchema.safeParse(record[metric]);
    // eslint-disable-next-line security/detect-object-injection -- as above
    if (parsed.success) latest[metric] = parsed.data;
  }
  return latest;
}

/**
 * The cache after a snapshot: each number the snapshot has replaces the one
 * held, unless the one held was read later (a slow read landing after a
 * person typed newer numbers does not undo them).
 */
export function mergeLatest(
  latest: Latest,
  counts: Counts,
  source: MetricSource,
  at: Date,
): Latest {
  const merged: { [K in Metric]?: LatestEntry } = { ...latest };
  const iso = at.toISOString();
  for (const metric of METRICS) {
    // eslint-disable-next-line security/detect-object-injection -- a metric name from the closed list above
    const value = clampCount(counts[metric]);
    if (value === null) continue;
    // eslint-disable-next-line security/detect-object-injection -- as above
    const held = merged[metric];
    if (held !== undefined && Date.parse(held.at) > at.getTime()) continue;
    // eslint-disable-next-line security/detect-object-injection -- as above
    merged[metric] = { value, source, at: iso };
  }
  return merged;
}

/** Whether a set of numbers says anything at all. */
export function hasAnyCount(counts: Counts): boolean {
  // eslint-disable-next-line security/detect-object-injection -- a metric name from the closed list above
  return METRICS.some((metric) => clampCount(counts[metric]) !== null);
}

/**
 * Likes, comments and shares per view, from whichever of the three are known;
 * null under {@link ENGAGEMENT_MIN_VIEWS} views, or with none of the three.
 */
export function engagementRate(counts: Counts): number | null {
  const views = clampCount(counts.views);
  if (views === null || views < ENGAGEMENT_MIN_VIEWS) return null;
  const parts = [counts.likes, counts.comments, counts.shares]
    .map(clampCount)
    .filter((value): value is number => value !== null);
  if (parts.length === 0) return null;
  return parts.reduce((sum, value) => sum + value, 0) / views;
}

/** The numbers a cache holds, without their sources. */
export function countsOf(latest: Latest): {
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
} {
  return {
    views: latest.views?.value ?? null,
    likes: latest.likes?.value ?? null,
    comments: latest.comments?.value ?? null,
    shares: latest.shares?.value ?? null,
  };
}

/** Whether a number came from a measurement or from a person. */
export function isMeasured(source: MetricSource): boolean {
  return source !== "person";
}
