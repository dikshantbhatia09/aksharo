import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { currentWeekWindow, isoDateInZone } from "./streak.engine.js";
import { PrismaService } from "../common/index.js";
import { ScheduledTasksService } from "../common/scheduler/scheduled-tasks.service.js";
import { NotifyService } from "../notify/notify.service.js";

export const STREAK_NUDGE_TASK = "streak.tuesday-nudge";

/** Every 15 minutes; the task itself only acts on a Tuesday evening local to each workspace. */
const STREAK_NUDGE_CRON = "*/15 * * * *";

/** Tuesday-evening local hour the nudge fires at (D52: "mid-week is the peak loss day"). */
const NUDGE_LOCAL_HOUR = 18;

/**
 * Tuesday-evening nudge for a workspace with 0-1 publish days by Tuesday
 * (B06 brief §4): in-app (`streak-nudge` is an `IN_APP_KIND`) and email via
 * `NotifyService`, exactly like `credits/credits-low-balance.notifier.ts`'s
 * shape — best effort, never fails the sweep for one workspace's bad data.
 */
@Injectable()
export class StreakNudgeTask implements OnModuleInit {
  private readonly logger = new Logger(StreakNudgeTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: STREAK_NUDGE_TASK,
      cron: STREAK_NUDGE_CRON,
      run: async ({ at }) => {
        const sent = await this.runNow(at);
        if (sent > 0) this.logger.log({ sent }, "streak Tuesday nudges sent");
      },
    });
  }

  async runNow(now: Date = new Date()): Promise<number> {
    const rows = await this.prisma.streakExperiment.findMany({
      where: { holdout: false },
      include: {
        workspace: {
          select: {
            settings: true,
            owner: { select: { id: true, email: true, name: true, locale: true } },
          },
        },
      },
    });

    let sent = 0;
    for (const row of rows) {
      try {
        const timezone = timezoneOf(row.workspace.settings);
        if (!isTuesdayEvening(now, timezone)) continue;

        const window = currentWeekWindow(now, timezone);
        const events = await this.prisma.publishEvent.findMany({
          where: { workspaceId: row.workspaceId, at: { gte: window.start, lt: now } },
          select: { at: true },
        });
        const days = new Set(events.map((event) => isoDateInZone(event.at, timezone))).size;
        if (days > 1) continue; // already on track

        const todayKey = isoDateInZone(now, timezone);
        if (row.lastNudgeAt !== null && isoDateInZone(row.lastNudgeAt, timezone) === todayKey) {
          continue; // already nudged today (at-least-once scheduler)
        }

        const owner = row.workspace.owner;
        await this.notify.enqueue({
          kind: "streak-nudge",
          to: owner.email,
          locale: owner.locale,
          userId: owner.id,
          workspaceId: row.workspaceId,
          data: { name: owner.name ?? "there", days, level: row.level },
          idempotencyKey: `streak-nudge:${row.workspaceId}:${todayKey}`,
        });

        await this.prisma.streakExperiment.update({
          where: { workspaceId: row.workspaceId },
          data: { lastNudgeAt: now },
        });
        sent += 1;
      } catch (error) {
        this.logger.warn(
          {
            workspaceId: row.workspaceId,
            err: error instanceof Error ? error.message : String(error),
          },
          "streak nudge not sent",
        );
      }
    }
    return sent;
  }
}

function isTuesdayEvening(now: Date, timezone: string): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  return weekday === "Tue" && hour >= NUDGE_LOCAL_HOUR;
}

function timezoneOf(settings: unknown): string {
  if (settings !== null && typeof settings === "object" && "timezone" in settings) {
    const tz = (settings as Record<string, unknown>)["timezone"];
    if (typeof tz === "string" && tz.length > 0) return tz;
  }
  return "UTC";
}
