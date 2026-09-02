import { Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { cookieExpiryFrom, resolveAttribution } from "./attribution.js";
import { isSelfReferral } from "./fraud.js";
import { PrismaService } from "../common/index.js";
import { AuditService } from "../users/audit.service.js";

export interface RecordClickInput {
  readonly code: string;
  readonly ipHash?: string;
  readonly deviceHash?: string;
}

export interface RecordClickResult {
  readonly affiliateId: string;
  readonly code: string;
  readonly attributionExpiresAt: Date;
}

export interface AttachInput {
  readonly referredWorkspaceId: string;
  readonly referredUserId: string;
  readonly enteredCode?: string | null;
  readonly cookieCode?: string | null;
  readonly cookieExpiresAt?: Date | null;
  readonly ipHash?: string;
  readonly deviceHash?: string;
  readonly paymentFingerprint?: string;
}

/**
 * `/r/<code>` click recording and sign-up/checkout attribution resolution
 * (brief §2). The 60-day cookie itself is set by the web app
 * (`apps/web/app/(site)/r/[code]/route.ts`); this service is the source of
 * truth the web route and the sign-up flow both call into so "code beats
 * cookie, expired cookie ignored" lives in one place.
 */
@Injectable()
export class AttributionService {
  private readonly logger = new Logger(AttributionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * A code resolves either as an affiliate's own `affiliates.code`, or as a
   * `coupons.code` linked to one via `coupons.affiliateId` (brief §2) — a
   * discount coupon an affiliate hands out doubling as their attribution
   * code. The affiliate's own code takes precedence on a collision (there
   * should never be one; codes and coupon codes are both unique).
   */
  private async resolveAffiliateByCode(code: string) {
    const normalised = code.trim().toUpperCase();
    const direct = await this.prisma.affiliate.findUnique({ where: { code: normalised } });
    if (direct !== null) return direct;

    const coupon = await this.prisma.coupon.findUnique({
      where: { code: normalised },
      include: { affiliate: true },
    });
    return coupon?.affiliate ?? null;
  }

  async recordClick(input: RecordClickInput): Promise<RecordClickResult | null> {
    const affiliate = await this.resolveAffiliateByCode(input.code);
    if (affiliate === null || affiliate.status !== "approved") return null;

    const clickedAt = new Date();
    const attributionExpiresAt = cookieExpiryFrom(clickedAt);
    await this.prisma.affiliateClick.create({
      data: {
        id: ulid(),
        affiliateId: affiliate.id,
        code: affiliate.code,
        clickedAt,
        attributionExpiresAt,
        ipHash: input.ipHash ?? null,
        deviceHash: input.deviceHash ?? null,
      },
    });
    return { affiliateId: affiliate.id, code: affiliate.code, attributionExpiresAt };
  }

  /**
   * Resolves attribution for a newly-signed-up workspace and creates the
   * `referrals` row, unless the resolved affiliate is not approved or the
   * signup is a self-referral (brief §2: "self-referral detection ... reject
   * with audit").
   */
  async attach(
    input: AttachInput,
  ): Promise<{
    status: "attributed" | "rejected" | "none";
    reason?: string;
    affiliateId?: string;
  }> {
    const resolved = resolveAttribution({
      enteredCode: input.enteredCode,
      cookieCode: input.cookieCode,
      cookieExpiresAt: input.cookieExpiresAt,
    });
    if (resolved === null) return { status: "none" };

    const affiliate = await this.resolveAffiliateByCode(resolved.code);
    if (affiliate === null || affiliate.status !== "approved") return { status: "none" };

    if (
      isSelfReferral({
        affiliateUserId: affiliate.userId,
        referredUserId: input.referredUserId,
        referredDeviceHash: input.deviceHash ?? null,
        affiliateLastDeviceHash: null,
        referredPaymentFingerprint: input.paymentFingerprint ?? null,
        affiliatePaymentFingerprint: null,
      })
    ) {
      await this.audit.record({
        action: "affiliate.self_referral.rejected",
        resource: "referral",
        actorId: input.referredUserId,
        workspaceId: input.referredWorkspaceId,
        data: { affiliateId: affiliate.id, code: resolved.code },
      });
      return { status: "rejected", reason: "self_referral" };
    }

    const existing = await this.prisma.referral.findUnique({
      where: { referredWorkspaceId: input.referredWorkspaceId },
    });
    if (existing !== null) return { status: "attributed", affiliateId: affiliate.id };

    await this.prisma.referral.create({
      data: {
        id: ulid(),
        affiliateId: affiliate.id,
        referredWorkspaceId: input.referredWorkspaceId,
        source: resolved.source,
        status: "attributed",
        ipHash: input.ipHash ?? null,
        deviceHash: input.deviceHash ?? null,
      },
    });
    await this.audit.record({
      action: "affiliate.referral.attributed",
      resource: "referral",
      actorId: input.referredUserId,
      workspaceId: input.referredWorkspaceId,
      data: { affiliateId: affiliate.id, code: resolved.code, source: resolved.source },
    });
    return { status: "attributed", affiliateId: affiliate.id };
  }
}
