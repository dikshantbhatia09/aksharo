import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { ADMIN_AUTH_ERRORS } from "./admin-step-up.constants.js";
import { generateTotpSecret, totpProvisioningUri, verifyTotpCode } from "./totp.js";
import { TokenService } from "../../auth/token.service.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";

import type { $Enums } from "@prisma/client";

export interface StepUpResult {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly adminRoles: readonly $Enums.AdminRoleName[];
}

/**
 * The admin auth surface: TOTP enrolment and `POST /admin/auth/step-up`
 * (CONTRACTS §5, amended 2026-09-03 after B13).
 *
 * Kept out of `AdminGuard`'s own module boundary deliberately — these three
 * routes are reached with an ordinary (non-admin) access token, by a user who
 * holds an `admin_roles` grant but has not yet stepped up, so they sit behind
 * `JwtAuthGuard` alone, never `AdminGuard` (which requires `kind: "admin"` —
 * the very thing this service mints).
 */
@Injectable()
export class AdminStepUpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: CommonAuditService,
  ) {}

  /** The user's active (non-revoked) `admin_roles`, or throws `common/forbidden` if none. */
  private async requireActiveRoles(userId: string): Promise<$Enums.AdminRoleName[]> {
    const grants = await this.prisma.adminRole.findMany({
      where: { userId, revokedAt: null },
      select: { role: true },
    });
    if (grants.length === 0) {
      throw new AppException(
        ADMIN_AUTH_ERRORS.noActiveRoles,
        "This account holds no active admin role.",
        HttpStatus.FORBIDDEN,
      );
    }
    return grants.map((g) => g.role);
  }

  /** Issue a fresh TOTP secret. Re-enrolling replaces any unverified secret; a verified one must be reset by a superadmin. */
  async enroll(
    userId: string,
    accountName: string,
  ): Promise<{ secret: string; otpauthUrl: string }> {
    await this.requireActiveRoles(userId);

    const existing = await this.prisma.adminTotp.findUnique({ where: { userId } });
    if (existing?.verifiedAt != null) {
      throw new AppException(
        ADMIN_AUTH_ERRORS.totpAlreadyEnrolled,
        "TOTP is already enrolled and verified for this account. Ask a superadmin to reset it.",
        HttpStatus.CONFLICT,
      );
    }

    const secret = generateTotpSecret();
    await this.prisma.adminTotp.upsert({
      where: { userId },
      create: { userId, secret },
      update: { secret, verifiedAt: null, enrolledAt: new Date() },
    });

    return {
      secret,
      otpauthUrl: totpProvisioningUri({ secret, accountName, issuer: "Montaj Admin" }),
    };
  }

  /** Confirm enrolment: the first correct code marks `admin_totp.verified_at`. */
  async verifyEnrollment(userId: string, code: string): Promise<void> {
    await this.requireActiveRoles(userId);
    const totp = await this.prisma.adminTotp.findUnique({ where: { userId } });
    if (totp === null) {
      throw new AppException(
        ADMIN_AUTH_ERRORS.totpNotEnrolled,
        "Call POST /admin/auth/totp/enroll first.",
        HttpStatus.PRECONDITION_FAILED,
      );
    }
    if (!verifyTotpCode(totp.secret, code)) {
      throw new AppException(
        ADMIN_AUTH_ERRORS.invalidCode,
        "That code did not match.",
        HttpStatus.FORBIDDEN,
      );
    }
    await this.prisma.adminTotp.update({
      where: { userId },
      data: { verifiedAt: new Date(), lastUsedAt: new Date() },
    });
  }

  /**
   * Mint a `kind: "admin"` access token: 30-minute lifetime, carries
   * `adminRoles`, never refreshable (CONTRACTS §5). Requires an active
   * `admin_roles` grant, a verified `admin_totp` enrolment, and a currently
   * valid code.
   */
  async stepUp(
    userId: string,
    workspaceId: string,
    role: $Enums.MembershipRole,
    code: string,
    ip: string | undefined,
  ): Promise<StepUpResult> {
    const adminRoles = await this.requireActiveRoles(userId);

    const totp = await this.prisma.adminTotp.findUnique({ where: { userId } });
    if (totp === null || totp.verifiedAt === null) {
      throw new AppException(
        ADMIN_AUTH_ERRORS.totpNotVerified,
        "Enrol and verify TOTP before stepping up (POST /admin/auth/totp/enroll, then /verify).",
        HttpStatus.PRECONDITION_FAILED,
      );
    }
    if (!verifyTotpCode(totp.secret, code)) {
      await this.audit.record({
        action: "admin.step_up.denied",
        resource: "admin_session",
        actorId: userId,
        actorKind: "admin",
        ip,
      });
      throw new AppException(
        ADMIN_AUTH_ERRORS.invalidCode,
        "That code did not match.",
        HttpStatus.FORBIDDEN,
      );
    }

    await this.prisma.adminTotp.update({
      where: { userId },
      data: { lastUsedAt: new Date() },
    });

    const minted = this.tokens.mintAccessToken({
      userId,
      workspaceId,
      role,
      kind: "admin",
      jti: ulid(),
      adminRoles,
    });

    await this.audit.record({
      action: "admin.step_up.granted",
      resource: "admin_session",
      resourceId: minted.jti,
      actorId: userId,
      actorKind: "admin",
      ip,
      data: { adminRoles },
    });

    return { accessToken: minted.accessToken, expiresIn: minted.expiresIn, adminRoles };
  }
}
