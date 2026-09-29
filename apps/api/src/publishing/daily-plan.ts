/**
 * "Post one a day" (2026-09-29): each chosen clip goes out on its own day, at
 * the chosen time, on each chosen account - skipping days that account already
 * has a post on. Agencies advise posting at least three times a week and
 * ideally daily; this turns a run's clips into that rhythm in one go.
 *
 * Days are counted in the person's time zone (default India, `Asia/Kolkata`),
 * not in UTC, so "7 pm" means their evening. Time-zone arithmetic is done with
 * `Intl` - the API has no date library - by finding the zone's offset at the
 * instant, twice, so a day that changes its clocks still lands on the asked-for
 * wall time (India has no such days).
 */

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";
export const DEFAULT_DAILY_TIME = "19:00";

/** How far ahead a day is looked for before giving up: a year. */
const MAX_DAYS_AHEAD = 366;

export interface Clock {
  readonly hour: number;
  readonly minute: number;
}

/** `19:00` → `{19, 0}`; null for anything that is not a time of day. */
export function parseClock(value: string): Clock | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Whether `Intl` knows the zone (an IANA name such as `Asia/Kolkata`). */
export function isTimeZone(value: string): boolean {
  if (value.trim() === "" || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallTime(instant: Date, timeZone: string): WallTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    // Some engines still say 24 for midnight.
    hour: value("hour") % 24,
    minute: value("minute"),
    second: value("second"),
  };
}

/** The zone's offset from UTC at `instant`, in milliseconds (IST: +5:30). */
function offsetMs(instant: number, timeZone: string): number {
  const wall = wallTime(new Date(instant), timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** `YYYY-MM-DD` of `instant` on the zone's calendar. */
export function dayInZone(instant: Date, timeZone: string): string {
  const wall = wallTime(instant, timeZone);
  return `${String(wall.year)}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

/** The instant a wall-clock time on a day happens in the zone. */
export function zonedTimeToUtc(day: string, clock: Clock, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, date, clock.hour, clock.minute);
  const first = guess - offsetMs(guess, timeZone);
  // Again at the instant found: right across a change of the clocks too.
  return new Date(guess - offsetMs(first, timeZone));
}

/** `YYYY-MM-DD` plus `days`. */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, date + days));
  return next.toISOString().slice(0, 10);
}

export interface DailyPlanInput {
  readonly clipIds: readonly string[];
  readonly channelIds: readonly string[];
  readonly clock: Clock;
  readonly timeZone: string;
  readonly now: Date;
  /** The first day to consider; today by default. */
  readonly startDay?: string;
  /** Per channel, the days (`YYYY-MM-DD` in `timeZone`) that already have a post. */
  readonly usedDays: ReadonlyMap<string, ReadonlySet<string>>;
  /** A slot sooner than this is too close to set up; it moves to the next day. */
  readonly minLeadMs: number;
}

export interface DailySlot {
  readonly clipId: string;
  readonly channelId: string;
  readonly at: Date;
}

/**
 * One slot per clip per channel: clips in the order given, each on the next
 * day that channel has free. Channels are planned independently, so an
 * account that already posts on Tuesdays simply skips Tuesday.
 */
export function planDaily(input: DailyPlanInput): DailySlot[] {
  const slots: DailySlot[] = [];
  const firstDay = input.startDay ?? dayInZone(input.now, input.timeZone);
  for (const channelId of input.channelIds) {
    const used = new Set(input.usedDays.get(channelId) ?? []);
    let day = firstDay;
    for (const clipId of input.clipIds) {
      let at: Date | null = null;
      for (let tries = 0; tries <= MAX_DAYS_AHEAD; tries += 1) {
        const candidate = zonedTimeToUtc(day, input.clock, input.timeZone);
        const early = candidate.getTime() < input.now.getTime() + input.minLeadMs;
        if (!early && !used.has(day)) {
          at = candidate;
          break;
        }
        day = addDays(day, 1);
      }
      if (at === null) break;
      used.add(day);
      slots.push({ clipId, channelId, at });
      day = addDays(day, 1);
    }
  }
  return slots;
}
