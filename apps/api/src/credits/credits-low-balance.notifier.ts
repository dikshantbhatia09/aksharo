import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { TENTHS_PER_CREDIT } from "@montaj/config";

import { CREDITS_LOW_EVENT } from "./credits-low.event.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { NotifyService } from "../notify/notify.service.js";

/** Thresholds a workspace crosses on the way down (brief §7: "at 20% and 0"). */
const LOW_BALANCE_THRESHOLDS = [0.2, 0] as const;

/**
 * Fires the `low-credits` notification (already templated by A25, `notify.kinds.ts`)
 * the moment a balance crosses 20% or 0% of the account's monthly grant.
 *
 * **Edge-triggered, not level-triggered.** Every `reserve`/`settle`/`release` call
 * hands this the balance *before* and *after* the move; a threshold fires only
 * when the move carried the balance from above it to at or below it, so a
 * workspace sitting at 5% for a week gets one notification, not one per job.
 *
 * **Best effort.** A notification is a side effect of the ledger move that
 * actually matters (the balance itself, already committed), so a Redis or
 * `notify` outage here is logged and swallowed — never a reason to fail a
 * `reserve` or roll back a `settle` (mirrors `RealtimePublisher` and
 * `WorkspaceNotifier`, which make the same call for the same reason).
 *
 * This is also where CONTRACTS §4's `settle` over-settlement shortfall surfaces
 * to a human: when the ledger cannot cover a delta hold it settles only what was
 * held, which drives the balance to (or keeps it at) zero, and this notifier's
 * zero-threshold fire is what tells the workspace — there is no separate
 * `needs_credits` notify kind to maintain.
 */
@Injectable()
export class CreditsLowBalanceNotifier {
  private readonly logger = new Logger(CreditsLowBalanceNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * @param monthlyGrantTenths The denominator for "20%". A workspace with no
   * grant yet (a brand-new account) has nothing to be a percentage OF, so only
   * the absolute zero threshold applies.
   */
  async checkThreshold(input: {
    readonly workspaceId: string;
    readonly beforeTenths: number;
    readonly afterTenths: number;
    readonly monthlyGrantTenths: number;
  }): Promise<void> {
    try {
      const crossed = this.crossedThreshold(input);
      if (crossed === undefined) return;

      const workspace = await this.prisma.workspace.findFirst({
        where: { id: input.workspaceId, deletedAt: null },
        select: { owner: { select: { id: true, email: true, name: true, locale: true } } },
      });
      if (workspace === null) return;

      const minutes = Math.floor(input.afterTenths / TENTHS_PER_CREDIT);
      await this.notify.enqueue({
        kind: "low-credits",
        to: workspace.owner.email,
        locale: workspace.owner.locale,
        userId: workspace.owner.id,
        workspaceId: input.workspaceId,
        data: { name: workspace.owner.name ?? "there", minutes },
        // One notification per (workspace, threshold crossing, calendar day): a
        // balance oscillating around the same threshold within a burst of jobs
        // must not become a burst of e-mails.
        idempotencyKey: `low-credits:${input.workspaceId}:${String(crossed)}:${new Date().toISOString().slice(0, 10)}`,
      });
      this.emitter.emit(CREDITS_LOW_EVENT, {
        workspaceId: input.workspaceId,
        thresholdFraction: crossed,
        balanceTenths: input.afterTenths,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, workspaceId: input.workspaceId },
        "low-credit threshold notification not sent",
      );
    }
  }

  /** The threshold fraction just crossed, downward, or `undefined` if none was. */
  private crossedThreshold(input: {
    readonly beforeTenths: number;
    readonly afterTenths: number;
    readonly monthlyGrantTenths: number;
  }): number | undefined {
    if (input.afterTenths >= input.beforeTenths) return undefined; // only firing on the way down
    for (const threshold of LOW_BALANCE_THRESHOLDS) {
      const thresholdTenths = threshold === 0 ? 0 : Math.ceil(input.monthlyGrantTenths * threshold);
      if (threshold > 0 && input.monthlyGrantTenths <= 0) continue; // no grant, no percentage
      if (input.beforeTenths > thresholdTenths && input.afterTenths <= thresholdTenths) {
        return threshold;
      }
    }
    return undefined;
  }
}
