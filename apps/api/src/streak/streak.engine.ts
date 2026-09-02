import { createHash } from "node:crypto";

import {
  DEFAULT_HOLDOUT_PCT,
  FREE_STREAK_WEEKS,
  FREEZES_PER_MONTH,
  LEVEL_CREDIT_GRANT_TENTHS,
  LEVEL_DISCOUNT_PERCENT,
  MAX_LEVEL,
  MIN_LEVEL,
  PUBLISH_DAY_BAR,
  WEEKS_PER_LEVEL_UP,
  YEARLY_START_LEVEL,
} from "./streak.constants.js";

/**
 * Pure streak state machine (B06 brief, D52). Pure on purpose, the same
 * reasoning `billing/money.ts` gives for its own pricing functions — every
 * transition (kept week, missed-with-freeze, missed-without-freeze/paused,
 * resume, level-up, monthly freeze reset) has to be checkable with a fake
 * clock and no database.
 *
 * A level never decreases (acceptance criterion 1) — no function in this file
 * ever lowers `level`.
 */

// ---------------------------------------------------------------------------
// Holdout assignment
// ---------------------------------------------------------------------------

/**
 * Deterministic 50/50 (configurable) holdout split by workspace id hash — the
 * same workspace always lands on the same side, with no row to read first.
 * `pct` is "how much is holdout"; `50` is the default 50/50 split.
 */
export function assignHoldout(workspaceId: string, pct: number = DEFAULT_HOLDOUT_PCT): boolean {
  const digest = createHash("sha256").update(`streak_experiment:${workspaceId}`).digest();
  // First 4 bytes as an unsigned int, modulo 100 — uniform enough for a 50/50
  // (or any coarse percentage) split without pulling in a PRNG dependency.
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < pct;
}

// ---------------------------------------------------------------------------
// Week window (Mon–Sun, workspace timezone)
// ---------------------------------------------------------------------------

export interface WeekWindow {
  readonly start: Date; // Monday 00:00 local, stored as a UTC instant
  readonly end: Date; // following Monday 00:00 local (exclusive)
}

/**
 * The Mon–Sun window `now` falls in, expressed as UTC instants. `timezone` is
 * an IANA zone (`workspaces.settings.timezone`); defaults to UTC when unset.
 */
export function currentWeekWindow(now: Date, timezone: string = "UTC"): WeekWindow {
  const local = toZonedParts(now, timezone);
  // JS `getDay()`-style: 0 = Sunday .. 6 = Saturday. ISO weekday, Monday-first.
  const isoWeekday = local.weekday === 0 ? 7 : local.weekday;
  const daysSinceMonday = isoWeekday - 1;
  const startLocalMidnightUtcMs =
    zonedMidnightUtcMs(local, timezone) - daysSinceMonday * 86_400_000;
  const start = new Date(startLocalMidnightUtcMs);
  const end = new Date(startLocalMidnightUtcMs + 7 * 86_400_000);
  return { start, end };
}

/** The window immediately before `window` — used by the rollover task. */
export function previousWeekWindow(window: WeekWindow): WeekWindow {
  return {
    start: new Date(window.start.getTime() - 7 * 86_400_000),
    end: window.start,
  };
}

interface ZonedParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
  readonly weekday: number; // 0 (Sun) - 6 (Sat), in the target zone
}

function toZonedParts(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: weekdayNames.indexOf(get("weekday")),
  };
}

/** UTC-ms instant of local midnight for the zoned calendar date in `parts`. */
function zonedMidnightUtcMs(parts: ZonedParts, timezone: string): number {
  // Start from the UTC instant that has the same Y/M/D wall clock, then
  // correct for the zone's offset (handles DST without a tz database).
  const guessUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const offsetMs = zoneOffsetMs(new Date(guessUtc), timezone);
  return guessUtc - offsetMs;
}

function zoneOffsetMs(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - date.getTime();
}

/** ISO `YYYY-MM-DD` of `date` in `timezone` — what `publishDays` entries are. */
export function isoDateInZone(date: Date, timezone: string = "UTC"): string {
  const parts = toZonedParts(date, timezone);
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${String(parts.year)}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Weekly rollover — the state machine proper
// ---------------------------------------------------------------------------

export interface StreakState {
  readonly level: number;
  readonly consecutiveWeeks: number;
  readonly freezesRemaining: number;
  readonly paused: boolean;
  /** Free-plan credits-only variant: no discounts, no L4/5 credit grants. */
  readonly creditsOnly: boolean;
}

export type RolloverOutcome = "kept" | "froze" | "paused" | "resumed";

export interface RolloverResult {
  readonly next: StreakState;
  readonly outcome: RolloverOutcome;
  /** Set only on the tick where `next.level` differs from the input's. */
  readonly leveledUpTo?: number;
  /** Set only on the tick the Free credits-only reward fires. */
  readonly freeCreditReward: boolean;
}

/**
 * Apply one week's result to the current state. `publishDayCount` is how many
 * distinct calendar days in the week that just ended had at least one publish
 * event (export or plugin apply).
 *
 * Order of operations for a missed week: auto-freeze first (if any remain),
 * pause only once freezes are exhausted — matching D52's "2 auto-applied
 * freezes per month; a missed week pauses progression" reading (a freeze is
 * spent before a pause is ever reached).
 */
export function rolloverWeek(state: StreakState, publishDayCount: number): RolloverResult {
  const kept = publishDayCount >= PUBLISH_DAY_BAR;

  if (kept) {
    if (state.creditsOnly) {
      const consecutiveWeeks = state.consecutiveWeeks + 1;
      if (consecutiveWeeks >= FREE_STREAK_WEEKS) {
        return {
          next: { ...state, consecutiveWeeks: 0, paused: false },
          outcome: state.paused ? "resumed" : "kept",
          freeCreditReward: true,
        };
      }
      return {
        next: { ...state, consecutiveWeeks, paused: false },
        outcome: state.paused ? "resumed" : "kept",
        freeCreditReward: false,
      };
    }

    if (state.paused) {
      // Resuming: the level never decreases (unaffected) and the progression
      // counter restarts from this kept week (D52: "pauses ... one export
      // restores it" — restoring is not the same as re-crediting lost weeks).
      return {
        next: { ...state, consecutiveWeeks: 1, paused: false },
        outcome: "resumed",
        freeCreditReward: false,
      };
    }

    const consecutiveWeeks = state.consecutiveWeeks + 1;
    if (consecutiveWeeks >= WEEKS_PER_LEVEL_UP && state.level < MAX_LEVEL) {
      const level = Math.min(MAX_LEVEL, state.level + 1);
      return {
        next: { ...state, level, consecutiveWeeks: 0 },
        outcome: "kept",
        leveledUpTo: level,
        freeCreditReward: false,
      };
    }
    return {
      next: { ...state, consecutiveWeeks },
      outcome: "kept",
      freeCreditReward: false,
    };
  }

  // Missed week.
  if (state.freezesRemaining > 0) {
    return {
      next: { ...state, freezesRemaining: state.freezesRemaining - 1 },
      outcome: "froze",
      freeCreditReward: false,
    };
  }

  return {
    next: { ...state, consecutiveWeeks: 0, paused: true },
    outcome: "paused",
    freeCreditReward: false,
  };
}

/** Calendar-month freeze reset (D52: 2 auto-freezes per month). */
export function resetFreezesForNewMonth(state: StreakState): StreakState {
  return { ...state, freezesRemaining: FREEZES_PER_MONTH };
}

/** Initial state for a newly assigned workspace. Yearly subscribers start at L4. */
export function initialState(input: {
  readonly yearly: boolean;
  readonly creditsOnly: boolean;
}): StreakState {
  return {
    level: input.creditsOnly ? MIN_LEVEL : input.yearly ? YEARLY_START_LEVEL : MIN_LEVEL,
    consecutiveWeeks: 0,
    freezesRemaining: FREEZES_PER_MONTH,
    paused: false,
    creditsOnly: input.creditsOnly,
  };
}

// ---------------------------------------------------------------------------
// Reward lookups (pure; the service applies them via B01/B02's facades)
// ---------------------------------------------------------------------------

/** `undefined` when the level carries no renewal discount (L1, L4, L5). */
export function discountPercentForLevel(level: number): number | undefined {
  return LEVEL_DISCOUNT_PERCENT[level];
}

/** `undefined` when the level carries no monthly credit grant (L1-L3). */
export function creditGrantTenthsForLevel(level: number): number | undefined {
  return LEVEL_CREDIT_GRANT_TENTHS[level];
}
