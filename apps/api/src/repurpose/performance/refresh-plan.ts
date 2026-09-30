/**
 * When a post's numbers are read again (2026-10-05): often while it is new,
 * less often as it ages, and not at all after its first month.
 *
 * A clip's views mostly arrive in its first two days, so that is when a read
 * says most; after a week a read every few days is plenty, and after a month
 * the number barely moves - one last read is taken at the month and then the
 * post is left alone. Measured from when the post went out (`posted_at`), or
 * from when Aksharo first heard of it when that is not known.
 *
 * Reads are budgeted per source (`performance.constants.ts`), and the due
 * queue is served oldest-read first, so when more is due than the budget
 * allows, every post still gets its turn and the schedule simply stretches.
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** How often a post is read at each age. Ordered; the last tier runs to {@link READ_WINDOW_MS}. */
export const READ_TIERS: readonly { readonly untilAgeMs: number; readonly everyMs: number }[] = [
  { untilAgeMs: 2 * DAY_MS, everyMs: 6 * HOUR_MS },
  { untilAgeMs: 7 * DAY_MS, everyMs: DAY_MS },
  { untilAgeMs: 30 * DAY_MS, everyMs: 3 * DAY_MS },
];

/** Past this age a post is not read again (after one last read at it). */
export const READ_WINDOW_MS = 30 * DAY_MS;

/** A failed read waits this, doubled per failure in a row, up to a day. */
export const READ_RETRY_BASE_MS = HOUR_MS;
export const READ_RETRY_MAX_MS = DAY_MS;
/**
 * Reads in a row that failed or found nothing before a post stops being read:
 * a deleted post, a private video, a platform whose analytics Postiz does not
 * have. Numbers can still be typed in by hand.
 */
export const MAX_READ_FAILURES = 5;

/** How often a post of this age is read. */
export function readEveryMs(ageMs: number): number {
  for (const tier of READ_TIERS) {
    if (ageMs < tier.untilAgeMs) return tier.everyMs;
  }
  const last = READ_TIERS[READ_TIERS.length - 1];
  return last === undefined ? DAY_MS : last.everyMs;
}

/**
 * The next read after one that found numbers at `readAt`, for a post that
 * went out at `anchor`; null once the month is read.
 */
export function nextReadAfter(anchor: Date, readAt: Date): Date | null {
  const end = anchor.getTime() + READ_WINDOW_MS;
  if (readAt.getTime() >= end) return null;
  const next = readAt.getTime() + readEveryMs(readAt.getTime() - anchor.getTime());
  // The last read is taken at the month, not skipped past it.
  return new Date(Math.min(next, end));
}

/**
 * The next read after `failures` failed (or empty) reads in a row, or null
 * when reading gives up. Never past the month's last read.
 */
export function nextReadAfterFailure(anchor: Date, now: Date, failures: number): Date | null {
  if (failures >= MAX_READ_FAILURES) return null;
  const end = anchor.getTime() + READ_WINDOW_MS;
  if (now.getTime() >= end) return null;
  const wait = Math.min(READ_RETRY_MAX_MS, READ_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
  return new Date(Math.min(now.getTime() + wait, end));
}

/**
 * The window Postiz's analytics are asked for, in days (its `date`
 * parameter): the shortest of a week, a month or a quarter that covers the
 * post's whole life, so a platform that answers per day answers for all of it.
 */
export function analyticsDays(anchor: Date, now: Date): 7 | 30 | 90 {
  const ageDays = (now.getTime() - anchor.getTime()) / DAY_MS;
  if (ageDays < 6) return 7;
  if (ageDays < 29) return 30;
  return 90;
}
