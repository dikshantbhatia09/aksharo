import { Injectable } from "@nestjs/common";

import { NinePassEligibilityService } from "./nine-pass-eligibility.service.js";
import { type OffersEligibilityView, type PassStatus, type PassView } from "./offers.dto.js";
import {
  FIRST_EXPORT_PRICE_INR_MINOR,
  TOPUP_TIERS,
  WEEK_PASS,
} from "../billing/billing.constants.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

import type { $Enums, PassPurchase } from "@prisma/client";

/**
 * The read model behind `GET /offers/eligibility` and `GET /offers/passes`
 * (the export-dialog upsell panel and the Subscription-overview pass chips).
 * Every amount here is read from `billing/billing.constants.js` (the same
 * numbers `PassesService` quotes from) — never hardcoded twice, per the
 * brief's "amounts from the API" acceptance criterion.
 */
@Injectable()
export class OffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ninePassEligibility: NinePassEligibilityService,
  ) {}

  async eligibility(workspaceId: string, now: Date = new Date()): Promise<OffersEligibilityView> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { currency: true, signupGiftConsumedAt: true },
    });

    const [ninePass, ninePassAvailable, activeWeekPass] = await Promise.all([
      this.ninePassEligibility.check(workspaceId, now),
      this.prisma.passPurchase.findFirst({
        where: { workspaceId, kind: "first_export", consumedAt: { not: null }, redeemedAt: null },
        select: { id: true },
      }),
      this.prisma.passPurchase.findFirst({
        where: { workspaceId, kind: "week_pass", endsAt: { gt: now } },
        orderBy: { endsAt: "desc" },
        select: { endsAt: true },
      }),
    ]);

    const currency = workspace.currency;
    const topupTier = TOPUP_TIERS[0];

    return {
      signupGift: { available: workspace.signupGiftConsumedAt === null },
      ninePass: {
        available: ninePassAvailable !== null,
        eligibleToBuy: ninePass.eligible,
        reason: ninePass.reason,
        nextEligibleAt: ninePass.nextEligibleAt,
        priceMinor: FIRST_EXPORT_PRICE_INR_MINOR,
        currency: "INR",
      },
      weekPass: {
        active: activeWeekPass !== null,
        endsAt: activeWeekPass?.endsAt?.toISOString() ?? null,
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        priceMinor: WEEK_PASS.prices[currency],
        currency,
        creditsGrantedTenths: WEEK_PASS.creditsTenths,
        days: WEEK_PASS.days,
      },
      topupFree149: {
        available: true,
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        priceMinor: topupTier.prices[currency],
        currency,
        credits: topupTier.credits,
      },
    };
  }

  async listPasses(workspaceId: string, now: Date = new Date()): Promise<PassView[]> {
    const rows = await this.prisma.passPurchase.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map((row) => toPassView(row, now));
  }
}

function statusOf(row: PassPurchase, now: Date): PassStatus {
  if (row.consumedAt === null) return "pending_payment";
  if (row.redeemedAt !== null) return "redeemed";
  if (row.endsAt !== null && row.endsAt.getTime() <= now.getTime()) return "expired";
  if (row.endsAt !== null) return "active"; // week_pass / pay_once, still within its window
  return "available"; // first_export / topup: paid, no fixed window
}

function toPassView(row: PassPurchase, now: Date): PassView {
  return {
    id: row.id,
    kind: row.kind as $Enums.PassPurchaseKind,
    status: statusOf(row, now),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    creditsGrantedTenths: row.creditsGrantedTenths,
    redeemedAt: row.redeemedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
