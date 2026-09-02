import { Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { TEAMS_AUDIT_ACTIONS } from "./teams.constants.js";
import { SubscriptionService } from "../../billing/subscription.service.js";
import { PrismaService } from "../../common/index.js";
import { type CreditsFacade, CREDITS_FACADE } from "../../credits/credits.facade.js";
import { AuditService } from "../../users/audit.service.js";
import { EntitlementService } from "../entitlement.service.js";

import type { ChangePlanDto } from "../../billing/billing.dto.js";

/** Subscription states a change-plan call may still be applied to. */
const LIVE_STATUSES = ["trialing", "active", "past_due", "paused"] as const;

/**
 * "Seat count → B01 subscription quantity with proration" and "pooled credits
 * (Agency: 900 × seats per month via B02 grants)" (brief §1), reacting to
 * `MEMBERSHIP_SEAT_EVENTS.seatsChanged` (`membership-events.ts`).
 *
 * Two independent adjustments, run every time a membership is accepted or
 * removed:
 *
 *   1. **Billed seats.** A workspace with a live subscription on a plan that
 *      carries `seatPrice` (Studio, Agency) has its subscription's `seats`
 *      raised or lowered to match active memberships, through
 *      `SubscriptionService.changePlan` — the same proration path a manual
 *      plan change uses (B01 owns the money maths; this only decides the new
 *      seat count). A plan without `seatPrice`, or a workspace with no live
 *      subscription at all (a team not yet checked out), has nothing to sync.
 *   2. **Pooled credits.** After the seat count settles, the entitlement is
 *      recomputed (`EntitlementService`, now scaled per seat for a `perSeat`
 *      plan) and `credit_accounts.monthly_grant_tenths` is raised to match,
 *      granting the *difference* as an immediate lot so a workspace that just
 *      added its third Agency seat has all 2,700 credits available at once,
 *      not only from the next monthly reset. Credits are only ever raised
 *      here, never clawed back — a seat removed mid-cycle keeps what was
 *      already pooled for that cycle; the next reset settles it down.
 *
 * A failure in either half is caught, audited and logged rather than thrown:
 * this runs off a membership event, well after the HTTP request that changed
 * membership has already answered 200/201 — there is nobody left to hand a
 * 500 to.
 */
@Injectable()
export class SeatBillingService {
  private readonly logger = new Logger(SeatBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    @Inject(CREDITS_FACADE) private readonly credits: CreditsFacade,
  ) {}

  async sync(workspaceId: string, reason: string): Promise<void> {
    try {
      await this.syncSeats(workspaceId);
    } catch (error) {
      this.logger.error({ err: error, workspaceId, reason }, "seat sync failed");
      await this.audit.record({
        action: TEAMS_AUDIT_ACTIONS.seatSyncFailed,
        resource: "subscription",
        workspaceId,
        data: { reason, stage: "seats", error: String(error) },
      });
    }

    try {
      await this.syncCredits(workspaceId);
    } catch (error) {
      this.logger.error({ err: error, workspaceId, reason }, "credit pool sync failed");
      await this.audit.record({
        action: TEAMS_AUDIT_ACTIONS.seatSyncFailed,
        resource: "credit_account",
        workspaceId,
        data: { reason, stage: "credits", error: String(error) },
      });
    }
  }

  private async syncSeats(workspaceId: string): Promise<void> {
    const [workspace, seatsUsed, subscription] = await Promise.all([
      this.prisma.workspace.findFirst({
        where: { id: workspaceId, deletedAt: null },
        select: { id: true, ownerId: true },
      }),
      this.prisma.membership.count({ where: { workspaceId, status: "active" } }),
      this.prisma.subscription.findFirst({
        where: { workspaceId, status: { in: [...LIVE_STATUSES] } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          seats: true,
          interval: true,
          plan: { select: { key: true, seatPrice: true } },
        },
      }),
    ]);
    if (workspace === null || subscription === null) return; // nothing billed yet
    if (subscription.plan.seatPrice === null) return; // this plan does not sell seats

    const desiredSeats = Math.max(1, seatsUsed);
    if (desiredSeats === subscription.seats) return;

    const body = {
      planKey: subscription.plan.key,
      interval: subscription.interval,
      seats: desiredSeats,
    } as ChangePlanDto;

    await this.subscriptions.changePlan(workspaceId, workspace.ownerId, body, {});

    await this.audit.record({
      action: TEAMS_AUDIT_ACTIONS.seatsSynced,
      resource: "subscription",
      resourceId: subscription.id,
      workspaceId,
      data: { before: subscription.seats, after: desiredSeats },
    });

    await this.entitlements.invalidate(workspaceId);
  }

  private async syncCredits(workspaceId: string): Promise<void> {
    const entitlement = await this.entitlements.forWorkspace(workspaceId);
    const targetTenths = entitlement.creditsPerMonthTenths;

    const subscription = await this.prisma.subscription.findFirst({
      where: { workspaceId, status: { in: [...LIVE_STATUSES] } },
      orderBy: { createdAt: "desc" },
      select: { currentPeriodEnd: true },
    });

    const account = await this.prisma.creditAccount.upsert({
      where: { workspaceId },
      create: {
        id: ulid(),
        workspaceId,
        balanceTenths: 0,
        monthlyGrantTenths: 0,
        grantResetAt: null,
      },
      update: {},
    });

    if (targetTenths <= account.monthlyGrantTenths) return; // never claw back here

    const diff = targetTenths - account.monthlyGrantTenths;
    const expiresAt = subscription?.currentPeriodEnd ?? undefined;

    await this.credits.grantLot({
      workspaceId,
      source: "grant",
      tenths: diff,
      reason: "seat_sync",
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });

    await this.prisma.creditAccount.update({
      where: { workspaceId },
      data: {
        monthlyGrantTenths: targetTenths,
        ...(account.grantResetAt === null && expiresAt !== undefined
          ? { grantResetAt: expiresAt }
          : {}),
      },
    });

    await this.audit.record({
      action: TEAMS_AUDIT_ACTIONS.creditsPooled,
      resource: "credit_account",
      resourceId: account.id,
      workspaceId,
      data: { grantedTenths: diff, monthlyGrantTenths: targetTenths },
    });
  }
}
