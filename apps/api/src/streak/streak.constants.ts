/**
 * Streak experiment constants (B06 brief, `04-pricing-and-monetization.md` v2
 * §Streak rewards, D52).
 */

/** A "publish day" week keeps its streak once it hits this many days. */
export const PUBLISH_DAY_BAR = 3;

/** Consecutive kept weeks needed to level up (L1 → L5, one level at a time). */
export const WEEKS_PER_LEVEL_UP = 4;

/** Auto-applied freezes granted at the start of every calendar month. */
export const FREEZES_PER_MONTH = 2;

/** Consecutive kept weeks the Free credits-only variant needs for a reward. */
export const FREE_STREAK_WEEKS = 2;

export const FREE_STREAK_REWARD_CREDITS_TENTHS = 50; // +5 credits

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 5;

/** Renewal discount percent by level (L2/L3 only; applied within the mandate cap). */
export const LEVEL_DISCOUNT_PERCENT: Readonly<Record<number, number>> = {
  2: 5,
  3: 10,
};

/** Monthly credit grant (tenths) by level (L4/L5 only), expiring with the period. */
export const LEVEL_CREDIT_GRANT_TENTHS: Readonly<Record<number, number>> = {
  4: 500, // +50 credits
  5: 1000, // +100 credits
};

/** Yearly subscribers start the streak at this level (D52). */
export const YEARLY_START_LEVEL = 4;

/** The feature flag key gating the whole experiment (`feature_flags.key`). */
export const STREAK_FLAG_KEY = "streak_experiment";

/** Deterministic 50/50 holdout split, expressed as "under this % is holdout". */
export const DEFAULT_HOLDOUT_PCT = 50;
