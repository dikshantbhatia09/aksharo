import { MAX_COUNT } from "./metrics.js";

import type { Counts } from "./metrics.js";

/**
 * Postiz's analytics for one post (2026-10-05), read into the four numbers.
 *
 * `GET /public/v1/analytics/post/{postId}?date=<days>` answers a list of
 * figures, each a label and a series (docs.postiz.com, checked 2026-09-29):
 *
 *     [{"label": "Likes", "data": [{"total": "150", "date": "2025-01-01"}, ...],
 *       "percentageChange": 16.7}, ...]
 *
 * The labels are the platform's own and vary by platform ("Views" on YouTube
 * and Instagram, "Impressions" on X and LinkedIn, "Retweets", "Reactions",
 * ...), so each of the four numbers is found by a short list of names, best
 * first. A figure's value is the SUM of its points: that is how Postiz's own
 * analytics view reads a series, and for a post most platforms answer one
 * point, dated the day it was read, holding the lifetime count. A figure
 * Postiz flags `average` is a rate, not a count, and is left out.
 *
 * Lenient about everything else, because Postiz changes between releases: a
 * wrapper object around the list, a number where a string was, commas in a
 * total, a label in capitals. What does not read is skipped, never guessed.
 */

export interface PostizAnalytics {
  readonly counts: Counts;
  /** The other figures, by their own label, rounded; at most {@link MAX_EXTRA}. */
  readonly extra: Readonly<Record<string, number>>;
}

const MAX_ITEMS = 100;
const MAX_POINTS = 400;
const MAX_EXTRA = 12;
const MAX_LABEL = 40;

/** The names each number goes by, best first. Compared lower-cased, spaces collapsed. */
const NAMES: Readonly<Record<keyof Counts, readonly string[]>> = Object.freeze({
  views: [
    "views",
    "video views",
    "video_views",
    "plays",
    "video plays",
    "view count",
    "total views",
    "impressions",
    "impression count",
  ],
  likes: ["likes", "like count", "reactions", "favorites", "favourites", "hearts"],
  comments: ["comments", "comment count", "replies"],
  shares: ["shares", "share count", "reposts", "retweets"],
});

const WRAPPER_KEYS = ["analytics", "data", "items", "results", "metrics"] as const;

function normalLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/** A point's total: a whole number, or null. "1,234" and 1234 both read; "12k" does not. */
function totalOf(value: unknown): number | null {
  let number: number;
  if (typeof value === "number") {
    number = value;
  } else if (typeof value === "string") {
    const [whole = "", fraction, ...rest] = value.trim().replace(/,/g, "").split(".");
    if (!/^\d+$/.test(whole) || rest.length > 0) return null;
    if (fraction !== undefined && !/^\d+$/.test(fraction)) return null;
    number = Number(whole);
  } else {
    return null;
  }
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}

function listOf(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of WRAPPER_KEYS) {
      // eslint-disable-next-line security/detect-object-injection -- a key from the closed list above
      const inner = record[key];
      if (Array.isArray(inner)) return inner;
    }
  }
  return null;
}

/** One figure's summed value, or null when none of its points reads. */
function figureValue(item: Record<string, unknown>): number | null {
  const points = item["data"];
  if (!Array.isArray(points)) {
    // A figure with its total inline rather than as a series.
    return totalOf(item["total"] ?? item["value"]);
  }
  let sum = 0;
  let read = 0;
  for (const point of points.slice(0, MAX_POINTS)) {
    if (typeof point !== "object" || point === null) continue;
    const total = totalOf((point as Record<string, unknown>)["total"]);
    if (total === null) continue;
    sum += total;
    read += 1;
  }
  return read === 0 ? null : Math.min(MAX_COUNT, sum);
}

/**
 * The four numbers (and the rest) in an analytics answer; null when the answer
 * is not a list of figures at all. An empty list reads as no numbers.
 */
export function parsePostizAnalytics(body: unknown): PostizAnalytics | null {
  const list = listOf(body);
  if (list === null) return null;

  const figures = new Map<string, { readonly label: string; readonly value: number }>();
  for (const entry of list.slice(0, MAX_ITEMS)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const label = item["label"] ?? item["name"];
    if (typeof label !== "string" || label.trim() === "") continue;
    // A rate (engagement %), which a sum of counts would misrepresent.
    if (item["average"] === true) continue;
    const value = figureValue(item);
    if (value === null) continue;
    const name = normalLabel(label);
    if (!figures.has(name)) figures.set(name, { label: label.trim().slice(0, MAX_LABEL), value });
  }

  const counts: { -readonly [K in keyof Counts]: number | null } = {
    views: null,
    likes: null,
    comments: null,
    shares: null,
  };
  const used = new Set<string>();
  for (const metric of Object.keys(NAMES) as (keyof Counts)[]) {
    // eslint-disable-next-line security/detect-object-injection -- a metric from the closed list above
    for (const name of NAMES[metric]) {
      const figure = figures.get(name);
      if (figure === undefined) continue;
      // eslint-disable-next-line security/detect-object-injection -- as above
      counts[metric] = figure.value;
      used.add(name);
      break;
    }
  }

  // `fromEntries` defines each label as an own property, so a label such as
  // `__proto__` is kept as data rather than read as the object's prototype.
  const extra = Object.fromEntries(
    [...figures]
      .filter(([name]) => !used.has(name))
      .slice(0, MAX_EXTRA)
      .map(([, figure]) => [figure.label, figure.value] as const),
  );
  return { counts, extra };
}
