import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import type { Env } from "@montaj/config";

import { AffiliateCodeService } from "./code.service.js";
import { decryptPan, encryptPan, isValidPan, panLast4 } from "./pan-crypto.js";
import { AppException, PrismaService } from "../common/index.js";
import { ENV } from "../config/config.module.js";
import { AuditService } from "../users/audit.service.js";

import type { ApplyAffiliateDto, AffiliateView } from "./affiliates.dto.js";
import type { $Enums } from "@prisma/client";

export const AFFILIATE_ERRORS = {
  regionUnsupported: "affiliate/region_unsupported",
  alreadyApplied: "affiliate/already_applied",
  notFound: "affiliate/not_found",
  invalidPan: "affiliate/invalid_pan",
} as const;

export const AFFILIATE_AUDIT_ACTIONS = {
  applied: "affiliate.applied",
  approved: "affiliate.approved",
  suspended: "affiliate.suspended",
  suspendedForReview: "affiliate.suspended_review",
  rejected: "affiliate.rejected",
  codeRevoked: "affiliate.code.revoked",
} as const;

/**
 * Application/approval and the affiliate's own profile (brief §1). India-only
 * at launch — a non-`IN` billing country is refused outright with
 * `affiliate/region_unsupported` rather than silently accepted and blocked
 * later at payout.
 */
@Injectable()
export class AffiliatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: AffiliateCodeService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private webOrigin(): string {
    return this.env.WEB_ORIGIN.replace(/\/$/, "");
  }

  private toView(affiliate: {
    id: string;
    code: string;
    status: string;
    tier: string;
    legalName: string | null;
    pan: string | null;
    gstin: string | null;
    balanceMinor: number;
    currency: string;
    approvedAt: Date | null;
    createdAt: Date;
  }): AffiliateView {
    return {
      id: affiliate.id,
      code: affiliate.code,
      status: affiliate.status,
      tier: affiliate.tier,
      legalName: affiliate.legalName,
      panLast4:
        affiliate.pan === null
          ? null
          : panLast4(decryptPan(affiliate.pan, this.env.INTERNAL_CALLBACK_SECRET)),
      gstin: affiliate.gstin,
      balanceMinor: affiliate.balanceMinor,
      currency: affiliate.currency,
      approvedAt: affiliate.approvedAt?.toISOString() ?? null,
      createdAt: affiliate.createdAt.toISOString(),
      referralLink: `${this.webOrigin()}/r/${affiliate.code}`,
    };
  }

  async apply(
    userId: string,
    input: ApplyAffiliateDto,
    context: { ip?: string },
  ): Promise<AffiliateView> {
    await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // India-only at launch (brief §1). `User` has no billing-country field of
    // its own; the applicant's own workspace(s) carry it, so any workspace
    // with a confirmed non-India billing country disqualifies the applicant.
    const foreignWorkspace = await this.prisma.workspace.findFirst({
      where: {
        ownerId: userId,
        billingCountryConfirmedAt: { not: null },
        billingCountry: { not: "IN" },
      },
    });
    if (foreignWorkspace !== null) {
      throw new AppException(
        AFFILIATE_ERRORS.regionUnsupported,
        "The affiliate programme is India-only at launch.",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!isValidPan(input.pan)) {
      throw new AppException(
        AFFILIATE_ERRORS.invalidPan,
        "PAN must match AAAAA9999A.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const existing = await this.prisma.affiliate.findUnique({ where: { userId } });
    if (existing !== null) {
      throw new AppException(
        AFFILIATE_ERRORS.alreadyApplied,
        "An affiliate application already exists for this account.",
        HttpStatus.CONFLICT,
      );
    }

    const code = await this.codes.generateUnique();
    const affiliate = await this.prisma.affiliate.create({
      data: {
        id: ulid(),
        userId,
        code,
        status: "pending",
        country: "IN",
        legalName: input.legalName,
        pan: encryptPan(input.pan, this.env.INTERNAL_CALLBACK_SECRET),
        gstin: input.gstin ?? null,
        payoutMethod: input.payoutMethod,
        currency: "INR",
      },
    });

    await this.audit.record({
      action: AFFILIATE_AUDIT_ACTIONS.applied,
      resource: "affiliate",
      resourceId: affiliate.id,
      actorId: userId,
      ip: context.ip,
    });

    return this.toView(affiliate);
  }

  async getForUser(userId: string): Promise<AffiliateView | null> {
    const affiliate = await this.prisma.affiliate.findUnique({ where: { userId } });
    return affiliate === null ? null : this.toView(affiliate);
  }

  async panVerifiedFor(affiliateId: string): Promise<boolean> {
    const affiliate = await this.prisma.affiliate.findUnique({
      where: { id: affiliateId },
      select: { pan: true, panVerifiedAt: true },
    });
    return affiliate !== null && affiliate.pan !== null && affiliate.panVerifiedAt !== null;
  }

  // -----------------------------------------------------------------------
  // Admin actions (brief §1: "admin endpoints; UI in B13").
  // -----------------------------------------------------------------------

  async adminApprove(affiliateId: string, actorId: string): Promise<AffiliateView> {
    await this.mustFind(affiliateId);
    const updated = await this.prisma.affiliate.update({
      where: { id: affiliateId },
      data: { status: "approved", approvedAt: new Date(), panVerifiedAt: new Date() },
    });
    await this.audit.record({
      action: AFFILIATE_AUDIT_ACTIONS.approved,
      resource: "affiliate",
      resourceId: affiliateId,
      actorId,
    });
    return this.toView(updated);
  }

  async adminSuspend(
    affiliateId: string,
    actorId: string,
    reason?: string,
  ): Promise<AffiliateView> {
    await this.mustFind(affiliateId);
    const updated = await this.prisma.affiliate.update({
      where: { id: affiliateId },
      data: { status: "suspended", fraudFlag: reason ?? null },
    });
    await this.audit.record({
      action: AFFILIATE_AUDIT_ACTIONS.suspended,
      resource: "affiliate",
      resourceId: affiliateId,
      actorId,
      data: reason === undefined ? undefined : { reason },
    });
    return this.toView(updated);
  }

  async adminReject(affiliateId: string, actorId: string, reason?: string): Promise<AffiliateView> {
    await this.mustFind(affiliateId);
    const updated = await this.prisma.affiliate.update({
      where: { id: affiliateId },
      data: { status: "rejected" },
    });
    await this.audit.record({
      action: AFFILIATE_AUDIT_ACTIONS.rejected,
      resource: "affiliate",
      resourceId: affiliateId,
      actorId,
      data: reason === undefined ? undefined : { reason },
    });
    return this.toView(updated);
  }

  async adminRevokeCode(affiliateId: string, actorId: string): Promise<AffiliateView> {
    await this.mustFind(affiliateId);
    const code = await this.codes.generateUnique();
    const updated = await this.prisma.affiliate.update({
      where: { id: affiliateId },
      data: { code },
    });
    await this.audit.record({
      action: AFFILIATE_AUDIT_ACTIONS.codeRevoked,
      resource: "affiliate",
      resourceId: affiliateId,
      actorId,
    });
    return this.toView(updated);
  }

  private async mustFind(affiliateId: string) {
    const affiliate = await this.prisma.affiliate.findUnique({ where: { id: affiliateId } });
    if (affiliate === null) {
      throw new AppException(
        AFFILIATE_ERRORS.notFound,
        "Affiliate not found.",
        HttpStatus.NOT_FOUND,
      );
    }
    return affiliate;
  }
}

export type AffiliateStatusEnum = $Enums.AffiliateStatus;
