import { z } from "zod";

import { zodDto } from "../common/index.js";

/**
 * Request and response schemas for `/streak/*` (B06 brief §3).
 */

export const streakViewSchema = z.object({
  /** `false` when the caller is not in the experiment at all (flag off, minor, holdout). */
  eligible: z.boolean(),
  /** `true` for a holdout-arm workspace — the API still answers, the web widget never renders it. */
  holdout: z.boolean(),
  creditsOnly: z.boolean(),
  level: z.number().int().min(1).max(5),
  publishDaysThisWeek: z.number().int().min(0),
  bar: z.number().int(),
  paused: z.boolean(),
  freezesRemaining: z.number().int().min(0),
  consecutiveWeeks: z.number().int().min(0),
  weekWindowStart: z.string(), // ISO date
  weekWindowEnd: z.string(), // ISO date
  /** e.g. "10% off your next renewal" or "+100 credits/month" — `null` at L1 or Free. */
  nextRewardLabel: z.string().nullable(),
  discountPercent: z.number().int().min(0).max(100),
  creditGrantTenths: z.number().int().min(0),
});
export type StreakView = z.infer<typeof streakViewSchema>;

/** `POST /streak/test-hooks` (test env only) — simulate N weeks at once. */
export const streakTestHookSchema = z.object({
  /** How many publish days to simulate in the *current* week before rolling it over. */
  publishDays: z.number().int().min(0).max(7).optional(),
  /** Roll the current week over and start a new one (applies the engine transition). */
  rolloverWeek: z.boolean().optional(),
  /** Force the calendar-month freeze reset to run now. */
  resetMonth: z.boolean().optional(),
});
export class StreakTestHookDto extends zodDto(streakTestHookSchema) {}
