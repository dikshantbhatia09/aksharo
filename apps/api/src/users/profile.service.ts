import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { ACCOUNT_ERRORS, DSR_DUE_DAYS } from "./account.constants.js";
import { A05_AUDIT_ACTIONS, AuditService } from "./audit.service.js";
import { PRIVACY_NOTICE_VERSION } from "./users.service.js";
import { AppException, ERROR_CODES, PrismaService } from "../common/index.js";

import type { UpdateProfileDto } from "./users.dto.js";
import type { $Enums, Prisma } from "@prisma/client";

/** The columns `/me` returns. */
const PROFILE_SELECT = {
  id: true,
  email: true,
  emailVerifiedAt: true,
  name: true,
  avatarUrl: true,
  locale: true,
  jurisdiction: true,
  ageBracket: true,
  marketingOptIn: true,
  onboarding: true,
  createdAt: true,
  lastSeenAt: true,
  deletedAt: true,
} as const;

export interface ProfileView {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  readonly locale: string;
  readonly jurisdiction: $Enums.Jurisdiction;
  readonly ageBracket: $Enums.AgeBracket;
  readonly marketingOptIn: boolean;
  readonly onboarding: Record<string, unknown>;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly deletedAt: string | null;
  readonly workspace: { readonly id: string; readonly role: $Enums.MembershipRole };
}

export interface RequestContextInfo {
  readonly ip?: string;
  readonly ua?: string;
}

export interface ErasureResult {
  readonly requestId: string;
  readonly status: $Enums.DsrStatus;
  readonly requestedAt: string;
  readonly dueAt: string;
  readonly sessionsRevoked: number;
}

/** `receivedAt` plus the DPDP Rule 14 answer period. */
export function dsrDueAt(from: Date): Date {
  return new Date(from.getTime() + DSR_DUE_DAYS * 24 * 60 * 60 * 1_000);
}

/**
 * The address a deleted account keeps.
 *
 * `users.email` is `UNIQUE` and `NOT NULL`, so erasure cannot simply blank it —
 * and it must not keep the real address either. `.invalid` is the reserved TLD of
 * RFC 2606: nothing can ever be delivered to it, and no future sign-up can
 * collide with it. The user id is already in the row, so this leaks nothing new.
 */
export function anonymisedEmail(userId: string): string {
  return `deleted-${userId.toLowerCase()}@deleted.invalid`;
}

/**
 * The profile behind `/me`: read it, change it, and start the two DPDP rights
 * requests a person can raise about their own account (D61, D70).
 *
 * Erasure here is deliberately **not** the cascade. It records the request, marks
 * the account, anonymises the address and revokes every session, so the account
 * is unusable from the moment the request lands; deleting the media, the
 * transcripts and the derived objects is B16's job and has 30 days to run.
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async view(
    userId: string,
    workspace: { id: string; role: $Enums.MembershipRole },
  ): Promise<ProfileView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: PROFILE_SELECT,
    });
    if (user === null) {
      throw new AppException(ERROR_CODES.notFound, "No such account.", HttpStatus.NOT_FOUND);
    }
    return toProfileView(user, workspace);
  }

  /**
   * Update the profile.
   *
   * `marketingOptIn` is mirrored into `consent_records` rather than only flipped
   * on the user row: D61 wants a notice-and-choice record of every change, and a
   * boolean column cannot say when or from where the choice was made.
   */
  async update(
    userId: string,
    workspace: { id: string; role: $Enums.MembershipRole },
    patch: UpdateProfileDto,
    context: RequestContextInfo,
  ): Promise<ProfileView> {
    const before = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ...PROFILE_SELECT, deletedAt: true },
    });
    if (before === null) {
      throw new AppException(ERROR_CODES.notFound, "No such account.", HttpStatus.NOT_FOUND);
    }
    if (before.deletedAt !== null) {
      throw new AppException(
        ACCOUNT_ERRORS.accountDeleted,
        "This account is scheduled for erasure and can no longer be changed.",
        HttpStatus.CONFLICT,
      );
    }

    const data: Prisma.UserUpdateInput = {};
    if ("name" in patch) data.name = patch.name ?? null;
    if ("avatarUrl" in patch) data.avatarUrl = patch.avatarUrl ?? null;
    if (patch.locale !== undefined) data.locale = patch.locale;
    if (patch.marketingOptIn !== undefined) data.marketingOptIn = patch.marketingOptIn;
    if (patch.onboarding !== undefined) data.onboarding = patch.onboarding;

    const now = new Date();
    const updated = await this.prisma.withTransaction(async (tx) => {
      const user = await tx.user.update({ where: { id: userId }, data, select: PROFILE_SELECT });

      if (patch.marketingOptIn !== undefined && patch.marketingOptIn !== before.marketingOptIn) {
        await tx.consentRecord.create({
          data: {
            id: ulid(),
            userId,
            workspaceId: workspace.id,
            purpose: "marketing",
            version: PRIVACY_NOTICE_VERSION,
            noticeVersion: PRIVACY_NOTICE_VERSION,
            granted: patch.marketingOptIn,
            grantedAt: now,
            withdrawnAt: patch.marketingOptIn ? null : now,
            ip: context.ip ?? null,
            ua: context.ua ?? null,
          },
        });
      }
      return user;
    });

    await this.audit.record({
      action: A05_AUDIT_ACTIONS.profileUpdated,
      resource: "user",
      resourceId: userId,
      actorId: userId,
      workspaceId: workspace.id,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { fields: Object.keys(data).sort() },
    });

    return toProfileView(updated, workspace);
  }

  /**
   * Accept an erasure request (D70, DPDP Rule 14).
   *
   * Idempotent: a second `DELETE /me` returns the request that is already open
   * rather than filling `dsr_requests` with duplicates of the same demand.
   */
  async requestErasure(
    userId: string,
    workspaceId: string,
    context: RequestContextInfo,
  ): Promise<ErasureResult> {
    const open = await this.prisma.dsrRequest.findFirst({
      where: { userId, kind: "erasure", status: { in: ["received", "verifying", "in_progress"] } },
      orderBy: { receivedAt: "desc" },
      select: { id: true, status: true, receivedAt: true, dueAt: true },
    });
    if (open !== null) {
      return {
        requestId: open.id,
        status: open.status,
        requestedAt: open.receivedAt.toISOString(),
        dueAt: open.dueAt.toISOString(),
        sessionsRevoked: 0,
      };
    }

    const now = new Date();
    const requestId = ulid();
    const dueAt = dsrDueAt(now);

    // The account is made unusable in one transaction, so a crash cannot leave a
    // live session behind a "deleted" user. The cascade over media, transcripts
    // and derived objects is B16 and runs against `dsr_requests`.
    const revoked = await this.prisma.withTransaction(async (tx) => {
      await tx.dsrRequest.create({
        data: {
          id: requestId,
          userId,
          kind: "erasure",
          receivedAt: now,
          dueAt,
          status: "received",
        },
      });
      await tx.user.update({
        where: { id: userId },
        data: {
          deletedAt: now,
          email: anonymisedEmail(userId),
          name: null,
          avatarUrl: null,
          passwordHash: null,
          mfaSecret: null,
          marketingOptIn: false,
        },
      });
      const sessions = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      return sessions.count;
    });

    await this.audit.record({
      action: A05_AUDIT_ACTIONS.erasureRequested,
      resource: "dsr_request",
      resourceId: requestId,
      actorId: userId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { kind: "erasure", dueAt: dueAt.toISOString(), sessionsRevoked: revoked },
    });

    return {
      requestId,
      status: "received",
      requestedAt: now.toISOString(),
      dueAt: dueAt.toISOString(),
      sessionsRevoked: revoked,
    };
  }
}

type ProfileRow = Prisma.UserGetPayload<{ select: typeof PROFILE_SELECT }>;

export function toProfileView(
  user: ProfileRow,
  workspace: { id: string; role: $Enums.MembershipRole },
): ProfileView {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    name: user.name,
    avatarUrl: user.avatarUrl,
    locale: user.locale,
    jurisdiction: user.jurisdiction,
    ageBracket: user.ageBracket,
    marketingOptIn: user.marketingOptIn,
    onboarding: (user.onboarding ?? {}) as Record<string, unknown>,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    deletedAt: user.deletedAt?.toISOString() ?? null,
    workspace: { id: workspace.id, role: workspace.role },
  };
}
