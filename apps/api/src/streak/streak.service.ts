import { Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { FREE_STREAK_REWARD_CREDITS_TENTHS, STREAK_FLAG_KEY } from "./streak.constants.js";
import { type StreakView } from "./streak.dto.js";
import {
  assignHoldout,
  creditGrantTenthsForLevel,
  currentWeekWindow,
  discountPercentForLevel,
  initialState,
  isoDateInZone,
  resetFreezesForNewMonth,
  rolloverWeek,
  type StreakState,
} from "./streak.engine.js";
import { PrismaService } from "../common/index.js";
import { CREDITS_FACADE, type CreditsFacade } from "../credits/credits.facade.js";

import type { StreakExperiment } from "@prisma/client";

/**
 * Orchestrates the B06 streak experiment: assignment (holdout), reads
 * (`GET /streak`), the weekly rollover task, and reward application
 * (renewal discount storage read by `StreakDiscountService`; credit grants
 * through `CreditsFacade.grantLot`, the same facade B01/B04 already use).
 *
 * DB rows are the source of truth for "which week / how many freezes"; the
 * pure transitions themselves all live in `streak.engine.ts` so they are
 * testable without a database (see `streak.engine.test.ts`).
 */
@Injectable()
export class StreakService {
  private readonly logger = new Logger(StreakService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CREDITS_FACADE) private readonly credits: CreditsFacade,
  ) {}

  // -------------------------------------------------------------------------
  // Assignment
  // -------------------------------------------------------------------------

  /**
   * Is the streak experiment even switched on? Reads `feature_flags` by key
   * (`streak_experiment`); missing row or `enabled=false` both mean off.
   */
  async flagEnabled(): Promise<boolean> {
    const flag = await this.prisma.featureFlag.findUnique({ where: { key: STREAK_FLAG_KEY } });
    return flag?.enabled === true;
  }

  /**
   * Ensure a workspace has an experiment row, creating one on first read.
   * Minors are never assigned (D52/D60) — returns `null` for them, and for
   * anything the flag has switched off, without ever writing a row.
   */
  async ensureAssigned(workspaceId: string): Promise<StreakExperiment | null> {
    if (!(await this.flagEnabled())) return null;

    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      include: {
        owner: { select: { ageBracket: true } },
        subscriptions: {
          where: { status: { in: ["active", "trialing", "past_due"] } },
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { plan: { select: { key: true } } },
        },
      },
    });
    if (workspace === null) return null;
    if (workspace.owner.ageBracket === "minor") return null; // D60: streaks off for minors

    const existing = await this.prisma.streakExperiment.findUnique({ where: { workspaceId } });
    if (existing !== null) return existing;

    const subscription = workspace.subscriptions[0];
    const creditsOnly = subscription === undefined || subscription.plan.key === "free";
    const yearly = subscription?.interval === "year";
    const holdout = assignHoldout(workspaceId);
    const state = initialState({ yearly, creditsOnly });
    const now = new Date();
    const window = currentWeekWindow(now, timezoneOf(workspace.settings));

    return this.prisma.streakExperiment.create({
      data: {
        id: ulid(),
        workspaceId,
        level: state.level,
        weekWindowStart: window.start,
        publishDays: [],
        consecutiveWeeks: state.consecutiveWeeks,
        frozen: 0,
        freezesRemaining: state.freezesRemaining,
        freezesMonth: monthLabel(now),
        paused: state.paused,
        holdout,
        creditsOnly,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  async getView(workspaceId: string): Promise<StreakView> {
    let row = await this.ensureAssigned(workspaceId);
    if (row !== null) row = await this.syncCreditsOnly(workspaceId, row);
    const timezone = await this.workspaceTimezone(workspaceId);
    const now = new Date();
    const window = currentWeekWindow(now, timezone);

    if (row === null) {
      return {
        eligible: false,
        holdout: false,
        creditsOnly: false,
        level: 1,
        publishDaysThisWeek: 0,
        bar: 3,
        paused: false,
        freezesRemaining: 0,
        consecutiveWeeks: 0,
        weekWindowStart: window.start.toISOString().slice(0, 10),
        weekWindowEnd: window.end.toISOString().slice(0, 10),
        nextRewardLabel: null,
        discountPercent: 0,
        creditGrantTenths: 0,
      };
    }

    const publishDaysThisWeek = await this.countPublishDays(
      workspaceId,
      window.start,
      window.end,
      timezone,
    );
    // Same gating as `getDiscountPercent` (B06b): holdout, paused and Free
    // credits-only all carry zero renewal discount and zero credit lot —
    // this read model must never claim a reward the workspace no longer
    // (or never did) qualify for.
    const rewardless = row.holdout || row.paused || row.creditsOnly;
    const discountPercent = rewardless ? 0 : (discountPercentForLevel(row.level) ?? 0);
    const creditGrantTenths = rewardless ? 0 : (creditGrantTenthsForLevel(row.level) ?? 0);

    return {
      eligible: true,
      holdout: row.holdout,
      creditsOnly: row.creditsOnly,
      level: row.level,
      publishDaysThisWeek,
      bar: 3,
      paused: row.paused,
      freezesRemaining: row.freezesRemaining,
      consecutiveWeeks: row.consecutiveWeeks,
      weekWindowStart: window.start.toISOString().slice(0, 10),
      weekWindowEnd: window.end.toISOString().slice(0, 10),
      nextRewardLabel: rewardLabel(row),
      discountPercent,
      creditGrantTenths,
    };
  }

  private async workspaceTimezone(workspaceId: string): Promise<string> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { settings: true },
    });
    return timezoneOf(workspace?.settings);
  }

  private async countPublishDays(
    workspaceId: string,
    start: Date,
    end: Date,
    timezone: string,
  ): Promise<number> {
    const events = await this.prisma.publishEvent.findMany({
      where: { workspaceId, at: { gte: start, lt: end } },
      select: { at: true },
    });
    const days = new Set(events.map((event) => isoDateInZone(event.at, timezone)));
    return days.size;
  }

  // -------------------------------------------------------------------------
  // Streak discount, read by `StreakDiscountService` for B01's renewal amount.
  // -------------------------------------------------------------------------

  async getDiscountPercent(workspaceId: string): Promise<number> {
    let row = await this.prisma.streakExperiment.findUnique({ where: { workspaceId } });
    if (row === null) return 0;
    row = await this.syncCreditsOnly(workspaceId, row);
    if (row.holdout || row.paused || row.creditsOnly) return 0;
    return discountPercentForLevel(row.level) ?? 0;
  }

  // -------------------------------------------------------------------------
  // Plan-derived `creditsOnly` (B06b): entitlement follows the *current*
  // plan at every rollover and every reward read, not the plan at assignment
  // time. `ensureAssigned` only sets `creditsOnly` on first insert; every
  // subsequent read/rollover re-derives it here and persists the flip so a
  // downgrade drops the L2/L3 discount and L4/L5 credit lot immediately, and
  // a later upgrade restores them (the level itself never changes either
  // way — see `streak.engine.ts#rolloverWeek`).
  // -------------------------------------------------------------------------

  private async currentPlanIsFree(workspaceId: string): Promise<boolean> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { workspaceId, status: { in: ["active", "trialing", "past_due"] } },
      orderBy: { createdAt: "desc" },
      select: { plan: { select: { key: true } } },
    });
    return subscription === null || subscription.plan.key === "free";
  }

  private async syncCreditsOnly(
    workspaceId: string,
    row: StreakExperiment,
  ): Promise<StreakExperiment> {
    const planIsFree = await this.currentPlanIsFree(workspaceId);
    if (row.creditsOnly === planIsFree) return row;
    return this.prisma.streakExperiment.update({
      where: { workspaceId },
      data: { creditsOnly: planIsFree },
    });
  }

  // -------------------------------------------------------------------------
  // Weekly rollover (the scheduled task calls this per workspace)
  // -------------------------------------------------------------------------

  /**
   * Close out the week the row is currently tracking and open the next one.
   * Idempotent per calendar week: a row whose `weekWindowStart` is already
   * the *current* window is left untouched (the scheduler is at-least-once).
   */
  async rolloverOne(workspaceId: string, now: Date = new Date()): Promise<void> {
    const row = await this.prisma.streakExperiment.findUnique({ where: { workspaceId } });
    if (row === null) return;

    const timezone = await this.workspaceTimezone(workspaceId);
    const liveWindow = currentWeekWindow(now, timezone);
    if (row.weekWindowStart.getTime() >= liveWindow.start.getTime()) return; // already current

    const closedWindow = {
      start: row.weekWindowStart,
      end: new Date(row.weekWindowStart.getTime() + 7 * 86_400_000),
    };
    const publishDayCount = await this.countPublishDays(
      workspaceId,
      closedWindow.start,
      closedWindow.end,
      timezone,
    );

    const currentMonth = monthLabel(now);
    let state: StreakState = {
      level: row.level,
      consecutiveWeeks: row.consecutiveWeeks,
      freezesRemaining: row.freezesRemaining,
      paused: row.paused,
      creditsOnly: row.creditsOnly,
    };
    const isNewMonth = row.freezesMonth !== currentMonth;
    let freezesMonth = row.freezesMonth;
    if (isNewMonth) {
      state = resetFreezesForNewMonth(state);
      freezesMonth = currentMonth;
    }

    const planIsFree = await this.currentPlanIsFree(workspaceId);
    const result = rolloverWeek(state, publishDayCount, planIsFree);

    await this.prisma.streakExperiment.update({
      where: { workspaceId },
      data: {
        level: result.next.level,
        consecutiveWeeks: result.next.consecutiveWeeks,
        freezesRemaining: result.next.freezesRemaining,
        paused: result.next.paused,
        creditsOnly: result.next.creditsOnly,
        frozen: row.frozen + (result.outcome === "froze" ? 1 : 0),
        freezesMonth,
        weekWindowStart: liveWindow.start,
        publishDays: [],
      },
    });

    if (row.holdout) return; // holdout workspaces never receive rewards

    if (result.freeCreditReward) {
      await this.credits.grantLot({
        workspaceId,
        source: "grant",
        tenths: FREE_STREAK_REWARD_CREDITS_TENTHS,
        reason: "streak.free_reward.two_week_streak",
        refId: `${workspaceId}:${isoDateInZone(now, timezone)}`,
      });
    }

    // The recurring "+N credits/month" for L4/L5 (D52): granted once per
    // calendar month for whichever level the workspace ends this tick at —
    // covers both "just leveled into L4/L5" and "already there, new month
    // started". `refId` embeds the month, so a re-run of this same tick
    // (scheduler at-least-once) is a duplicate `grantLot` call in practice
    // only guarded by that refId being descriptive, not a hard uniqueness
    // constraint this work package's `CreditsFacade` interface exposes.
    // `result.next.creditsOnly` guards a workspace that leveled up on the
    // paid track and then downgraded before this same monthly tick fired —
    // the engine never lets a creditsOnly workspace level into L4/L5 itself,
    // but a level earned pre-downgrade persists (a level never decreases),
    // so this is the only place a stale L4/L5 could otherwise re-grant.
    if (!result.next.creditsOnly && (isNewMonth || result.leveledUpTo !== undefined)) {
      const grantTenths = creditGrantTenthsForLevel(result.next.level);
      if (grantTenths !== undefined) {
        await this.grantMonthlyLevelCredits(workspaceId, result.next.level, grantTenths, now);
      }
    }
  }

  /**
   * L4/L5's "+N credits/month" — granted on the level-up tick and again every
   * time the calendar month rolls while still at that level, expiring with
   * the period (the plan's current billing month end, approximated here as
   * the end of the calendar month since streak rewards are not tied to a
   * specific subscription's anniversary).
   */
  private async grantMonthlyLevelCredits(
    workspaceId: string,
    level: number,
    tenths: number,
    now: Date,
  ): Promise<void> {
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    await this.credits.grantLot({
      workspaceId,
      source: "grant",
      tenths,
      expiresAt: monthEnd,
      reason: `streak.level_reward.L${String(level)}`,
      refId: `${workspaceId}:${monthLabel(now)}`,
    });
  }

  // -------------------------------------------------------------------------
  // Test hooks (test env only — gated by the controller)
  // -------------------------------------------------------------------------

  /**
   * Simulate `count` distinct publish DAYS in the week immediately BEFORE
   * the one the row is currently tracking — the same week {@link forceRollover}
   * treats as "closing" (it steps `weekWindowStart` back by exactly one week
   * before calling `rolloverOne`), so calling this and then `forceRollover`
   * counts them, exactly as a real week's worth of exports would.
   */
  async simulatePublishDays(workspaceId: string, count: number): Promise<void> {
    const row = await this.prisma.streakExperiment.findUnique({ where: { workspaceId } });
    const anchor = (row?.weekWindowStart.getTime() ?? Date.now()) - 7 * 86_400_000;
    for (let i = 0; i < count; i += 1) {
      await this.prisma.publishEvent.create({
        data: {
          id: ulid(),
          workspaceId,
          surface: "web",
          at: new Date(anchor + i * 86_400_000 + 3_600_000),
        },
      });
    }
  }

  async forceRollover(workspaceId: string): Promise<void> {
    const row = await this.prisma.streakExperiment.findUnique({ where: { workspaceId } });
    if (row === null) return;
    // Push the window back one week so `rolloverOne`'s idempotency guard lets it run.
    await this.prisma.streakExperiment.update({
      where: { workspaceId },
      data: { weekWindowStart: new Date(row.weekWindowStart.getTime() - 7 * 86_400_000) },
    });
    await this.rolloverOne(workspaceId);
  }

  async forceMonthReset(workspaceId: string): Promise<void> {
    await this.prisma.streakExperiment.update({
      where: { workspaceId },
      data: { freezesMonth: "reset" },
    });
  }
}

function rewardLabel(row: StreakExperiment): string | null {
  if (row.creditsOnly)
    return `${String(2 - (row.consecutiveWeeks % 2))} more kept week(s) for +5 credits`;
  const discount = discountPercentForLevel(row.level + 1);
  if (discount !== undefined)
    return `${String(discount)}% off your next renewal at L${String(row.level + 1)}`;
  const credits = creditGrantTenthsForLevel(row.level + 1);
  if (credits !== undefined)
    return `+${String(credits / 10)} credits/month at L${String(row.level + 1)}`;
  return null;
}

function monthLabel(date: Date): string {
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function timezoneOf(settings: unknown): string {
  if (settings !== null && typeof settings === "object" && "timezone" in settings) {
    const tz = (settings as Record<string, unknown>)["timezone"];
    if (typeof tz === "string" && tz.length > 0) return tz;
  }
  return "UTC";
}
