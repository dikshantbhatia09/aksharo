import { HttpStatus, Injectable } from "@nestjs/common";

import { evaluateNinePassEligibility, type NinePassEligibility } from "./nine-pass-eligibility.js";
import { OFFERS_ERRORS } from "./offers.constants.js";
import { AppException } from "../common/index.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { resolveWorkspacePlan } from "../jobs/plan.js";

/**
 * The database-backed half of ₹9-pass eligibility: resolves the workspace's
 * currency, live subscription plan and most recent `first_export` purchase,
 * then hands them to the pure {@link evaluateNinePassEligibility}.
 *
 * `billing/passes.service.ts#passCheckout` calls {@link assertEligible} before
 * quoting a `first_export` order (server-side enforcement, per the brief — a
 * client can never buy its way past this by simply not showing the button);
 * `offers.controller.ts`'s `GET /offers/eligibility` calls {@link check} to
 * tell the export dialog what to render and why.
 */
@Injectable()
export class NinePassEligibilityService {
  constructor(private readonly prisma: PrismaService) {}

  async check(workspaceId: string, now: Date = new Date()): Promise<NinePassEligibility> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { currency: true },
    });
    const [planKey, lastPurchase] = await Promise.all([
      resolveWorkspacePlan(this.prisma, workspaceId),
      this.prisma.passPurchase.findFirst({
        where: { workspaceId, kind: "first_export" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

    return evaluateNinePassEligibility({
      currency: workspace.currency,
      planKey,
      lastPurchaseAt: lastPurchase?.createdAt ?? null,
      now,
    });
  }

  /** Throws `offers/nine_pass_ineligible` when the workspace may not buy one right now. */
  async assertEligible(workspaceId: string, now: Date = new Date()): Promise<void> {
    const result = await this.check(workspaceId, now);
    if (result.eligible) return;

    const messages: Record<string, string> = {
      currency_not_inr: "The ₹9 clean export is INR only.",
      on_paid_plan: "The ₹9 clean export is for Free workspaces without a plan.",
      purchased_within_30_days: "One ₹9 clean export per account every 30 days.",
    };
    throw new AppException(
      OFFERS_ERRORS.ninePassIneligible,
      messages[result.reason ?? ""] ?? "Not eligible for the ₹9 clean export right now.",
      HttpStatus.CONFLICT,
      { reason: result.reason, nextEligibleAt: result.nextEligibleAt },
    );
  }
}
