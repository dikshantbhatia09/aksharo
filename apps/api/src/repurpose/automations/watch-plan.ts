import {
  WATCH_CURSOR_MAX,
  WATCH_MAX_VIDEO_AGE_MS,
  WATCH_RETRY_MAX_MS,
  WATCH_CHECK_EVERY_MS,
  WATCH_CHECK_JITTER_MS,
  WATCH_UPCOMING_WAIT_MS,
} from "./source-watch.constants.js";

import type { FeedEntry } from "./channel-feed.js";

/**
 * What one read of a channel's feed means for its watch (2026-10-02): which
 * uploads to record, as what, and what the watch has now seen. Pure - the
 * poller reads, writes and starts; this decides - so every rule below is a
 * unit test, not a database fixture.
 *
 * The rules, per entry, newest first:
 *
 *   1. Already seen (in the cursor) or already recorded: nothing to do.
 *   2. Published before the watch was made: the channel's back catalogue. On
 *      the FIRST read only, the newest `backfill` of them that are real videos
 *      are recorded `pending`, as asked for when the watch was made; the rest
 *      are only marked seen.
 *   3. A Short: recorded `skipped` (`short`), so the page can say so.
 *   4. No views yet: most likely a premiere or a stream that has not happened.
 *      Not marked seen, so the next read looks again; recorded `skipped`
 *      (`upcoming`) only once it has waited a week.
 *   5. Published more than a week before this read: `skipped` (`too_old`). A
 *      watch paused for a month, or read for the first time a week late, does
 *      not start a burst of runs nobody is waiting on.
 *   6. Anything else is a new upload: `pending`, to be started.
 */

export interface PlanInput {
  readonly now: Date;
  /** When the watch was made: uploads before it are the back catalogue. */
  readonly since: Date;
  /** No read has succeeded yet (the cursor is empty). */
  readonly firstRead: boolean;
  readonly backfill: number;
  /** The cursor: video ids already classified. */
  readonly seen: readonly string[];
  /** Video ids this watch already has a row for. */
  readonly recorded: ReadonlySet<string>;
  readonly entries: readonly FeedEntry[];
}

export interface PlannedVideo {
  readonly videoId: string;
  readonly title: string;
  readonly publishedAt: Date;
  readonly state: "pending" | "skipped";
  readonly reason: "short" | "too_old" | "upcoming" | null;
  readonly backfill: boolean;
}

export interface Plan {
  /** Rows to insert. */
  readonly videos: readonly PlannedVideo[];
  /** The new cursor: newest first, bounded. */
  readonly seen: readonly string[];
  /** Entries left for the next read (no views yet). */
  readonly waiting: readonly string[];
}

export function planFeed(input: PlanInput): Plan {
  const seen = new Set(input.seen);
  const now = input.now.getTime();
  const since = input.since.getTime();
  let backfillLeft = input.firstRead ? input.backfill : 0;

  const videos: PlannedVideo[] = [];
  const waiting: string[] = [];
  const classified: string[] = [];
  const entries = [...input.entries].sort(
    (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
  );

  for (const entry of entries) {
    const { videoId } = entry;
    if (seen.has(videoId) || input.recorded.has(videoId)) {
      classified.push(videoId);
      continue;
    }
    const published = entry.publishedAt.getTime();
    const upcoming = entry.views === 0;
    const base = { videoId, title: entry.title || videoId, publishedAt: entry.publishedAt };

    if (published < since) {
      if (backfillLeft > 0 && !entry.isShort && !upcoming) {
        videos.push({ ...base, state: "pending", reason: null, backfill: true });
        backfillLeft -= 1;
      }
      classified.push(videoId);
      continue;
    }

    if (entry.isShort) {
      videos.push({ ...base, state: "skipped", reason: "short", backfill: false });
    } else if (upcoming) {
      if (now - published < WATCH_UPCOMING_WAIT_MS) {
        waiting.push(videoId);
        continue;
      }
      videos.push({ ...base, state: "skipped", reason: "upcoming", backfill: false });
    } else if (now - published > WATCH_MAX_VIDEO_AGE_MS) {
      videos.push({ ...base, state: "skipped", reason: "too_old", backfill: false });
    } else {
      videos.push({ ...base, state: "pending", reason: null, backfill: false });
    }
    classified.push(videoId);
  }

  // Newest first: this read's classified entries, then what was seen before.
  const cursor: string[] = [];
  for (const videoId of [...classified, ...input.seen]) {
    if (cursor.length >= WATCH_CURSOR_MAX) break;
    if (!cursor.includes(videoId) && !waiting.includes(videoId)) cursor.push(videoId);
  }
  return { videos, seen: cursor, waiting };
}

/**
 * When a watch is read next after a read that worked: an hour, plus up to a
 * quarter of an hour at random, so watches made together drift apart.
 */
export function nextCheckAfterRead(now: Date, random: () => number = Math.random): Date {
  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * WATCH_CHECK_JITTER_MS);
  return new Date(now.getTime() + WATCH_CHECK_EVERY_MS + jitter);
}

/**
 * After `failures` failed reads in a row: an hour, doubling, at most a day -
 * a channel that is down, or a feed that will not parse, is asked about less
 * and less rather than every hour for ever.
 */
export function nextCheckAfterFailure(
  now: Date,
  failures: number,
  random: () => number = Math.random,
): Date {
  const wait = Math.min(
    WATCH_RETRY_MAX_MS,
    WATCH_CHECK_EVERY_MS * 2 ** Math.max(0, Math.min(10, failures - 1)),
  );
  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * WATCH_CHECK_JITTER_MS);
  return new Date(now.getTime() + wait + jitter);
}

/** A watch's cursor (`{ seen: [...] }`) read back; anything else is an empty one. */
export function seenOf(cursor: unknown): string[] {
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return [];
  const seen = (cursor as Record<string, unknown>)["seen"];
  if (!Array.isArray(seen)) return [];
  return seen.filter((id): id is string => typeof id === "string" && /^[\w-]{11}$/.test(id));
}
