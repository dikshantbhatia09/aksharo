import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { WORKSPACE_NOTIFIER } from "./workspace-notifier.js";
import { WORKSPACE_ERRORS, MAX_MEMBERS_PER_WORKSPACE } from "./workspaces.constants.js";
import { AppException, PrismaService, roleAtLeast } from "../common/index.js";
import { A05_AUDIT_ACTIONS, AuditService } from "../users/audit.service.js";
import { normaliseEmail } from "../users/users.service.js";

import type { WorkspaceNotifier } from "./workspace-notifier.js";
import type { ChangeRoleDto, InviteMemberDto } from "./workspaces.dto.js";
import type { RequestContextInfo } from "../users/profile.service.js";
import type { $Enums } from "@prisma/client";

export interface MemberView {
  readonly id: string;
  readonly userId: string | null;
  readonly email: string | null;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  readonly role: $Enums.MembershipRole;
  readonly status: $Enums.MembershipStatus;
  readonly seatBilled: boolean;
  readonly createdAt: string;
}

export interface InvitationView {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly role: $Enums.MembershipRole;
  readonly invitedEmail: string | null;
  readonly createdAt: string;
}

const MEMBER_SELECT = {
  id: true,
  userId: true,
  role: true,
  status: true,
  seatBilled: true,
  invitedEmail: true,
  createdAt: true,
  user: { select: { email: true, name: true, avatarUrl: true } },
} as const;

/**
 * Memberships: who is in a workspace, as what, and how they got there.
 *
 * The invariants, all enforced here rather than by convention:
 *
 *   * **exactly one owner**, who cannot be demoted or removed — `workspaces.owner_id`
 *     is a `NOT NULL` foreign key, so a workspace without one is unrepresentable;
 *   * an invitation is a `memberships` row with `status: invited` and no `user_id`,
 *     which is what makes "invited but never signed up" expressible at all;
 *   * accepting is the only way `user_id` is ever filled in, and only by the
 *     person whose verified address the invitation names.
 *
 * `seatBilled` is written but never charged: B08 owns seat billing and needs the
 * field to already mean something when it arrives.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(WORKSPACE_NOTIFIER) private readonly notifier: WorkspaceNotifier,
  ) {}

  /** Members and outstanding invitations, owner first, then by join date. */
  async list(workspaceId: string): Promise<MemberView[]> {
    const rows = await this.prisma.membership.findMany({
      where: { workspaceId, status: { in: ["invited", "active", "suspended"] } },
      orderBy: { createdAt: "asc" },
      select: MEMBER_SELECT,
    });
    return rows
      .map(toMemberView)
      .sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner"));
  }

  /**
   * Invite an address.
   *
   * The row is created before the mail is sent, and the mail carries the row's
   * id: an invitation that exists but was never delivered can be resent, whereas
   * a mail sent for a row that failed to insert is a dead link. The address is
   * matched case-insensitively, because that is how a person will type it.
   */
  async invite(
    workspaceId: string,
    actorId: string,
    body: InviteMemberDto,
    context: RequestContextInfo,
  ): Promise<MemberView> {
    const email = normaliseEmail(body.email);

    const [workspace, actor, existingUser] = await Promise.all([
      this.prisma.workspace.findFirst({
        where: { id: workspaceId, deletedAt: null },
        select: { id: true, name: true, type: true },
      }),
      this.prisma.user.findUnique({ where: { id: actorId }, select: { name: true } }),
      this.prisma.user.findUnique({
        where: { email },
        select: { id: true, deletedAt: true },
      }),
    ]);
    if (workspace === null) {
      throw new AppException(WORKSPACE_ERRORS.notFound, "No such workspace.", HttpStatus.NOT_FOUND);
    }

    const alreadyThere = await this.prisma.membership.findFirst({
      where: {
        workspaceId,
        status: { in: ["invited", "active", "suspended"] },
        OR: [
          { invitedEmail: email },
          ...(existingUser === null ? [] : [{ userId: existingUser.id }]),
        ],
      },
      select: { id: true, status: true },
    });
    if (alreadyThere !== null) {
      throw new AppException(
        WORKSPACE_ERRORS.memberAlreadyPresent,
        "That address is already a member of this workspace, or has an invitation waiting.",
        HttpStatus.CONFLICT,
        { status: alreadyThere.status },
      );
    }

    const count = await this.prisma.membership.count({
      where: { workspaceId, status: { in: ["invited", "active"] } },
    });
    if (count >= MAX_MEMBERS_PER_WORKSPACE) {
      throw new AppException(
        WORKSPACE_ERRORS.seatLimitReached,
        `A workspace holds at most ${String(MAX_MEMBERS_PER_WORKSPACE)} members while seat billing is in development.`,
        HttpStatus.CONFLICT,
        { limit: MAX_MEMBERS_PER_WORKSPACE },
      );
    }

    const membership = await this.prisma.membership.create({
      data: {
        id: ulid(),
        workspaceId,
        // Deliberately null even when the address already has an account: the row
        // becomes a membership only when that person accepts it themselves.
        userId: null,
        invitedEmail: email,
        role: body.role,
        status: "invited",
        seatBilled: false,
      },
      select: MEMBER_SELECT,
    });

    await this.notifier.memberInvited({
      to: email,
      invitationId: membership.id,
      workspaceName: workspace.name,
      invitedByName: actor?.name ?? null,
      role: body.role,
    });

    await this.audit.record({
      action: A05_AUDIT_ACTIONS.memberInvited,
      resource: "membership",
      resourceId: membership.id,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      // The address is the point of the row, and `audit_log` is already access
      // controlled; the *log line* masks it, which is where it would leak.
      data: { invitedEmail: email, role: body.role },
    });

    return toMemberView(membership);
  }

  /** The invitations waiting for the caller's verified address. */
  async invitationsFor(userId: string): Promise<InvitationView[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true, deletedAt: true },
    });
    // An unverified address must not collect invitations: anybody can type an
    // address into a sign-up form, and an invitation is an authorisation grant.
    if (user === null || user.deletedAt !== null || user.emailVerifiedAt === null) return [];

    const rows = await this.prisma.membership.findMany({
      where: {
        invitedEmail: user.email,
        status: "invited",
        userId: null,
        workspace: { deletedAt: null },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        workspaceId: true,
        role: true,
        invitedEmail: true,
        createdAt: true,
        workspace: { select: { name: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      workspaceName: row.workspace.name,
      role: row.role,
      invitedEmail: row.invitedEmail,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Accept an invitation.
   *
   * The invitation id is a ULID the invitee was mailed, and the row's
   * `invited_email` must equal the caller's **verified** address — the id alone
   * is not the authorisation, which is what stops a leaked link from admitting
   * whoever finds it.
   *
   * The caller's token is still scoped to whichever workspace they were in, so
   * the response says which workspace to exchange a token for; joining does not
   * silently move somebody's session.
   */
  async accept(
    invitationId: string,
    userId: string,
    context: RequestContextInfo,
  ): Promise<{ workspaceId: string; role: $Enums.MembershipRole }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true, deletedAt: true },
    });
    if (user === null || user.deletedAt !== null || user.emailVerifiedAt === null) {
      throw invitationNotFound();
    }

    const invitation = await this.prisma.membership.findFirst({
      where: {
        id: invitationId,
        status: "invited",
        userId: null,
        invitedEmail: user.email,
        workspace: { deletedAt: null },
      },
      select: { id: true, workspaceId: true, role: true },
    });
    if (invitation === null) throw invitationNotFound();

    // A second membership row for the same (workspace, user) would violate the
    // unique index; if the person is somehow already in, accept idempotently.
    const existing = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId } },
      select: { id: true, role: true, status: true },
    });
    if (existing !== null) {
      await this.prisma.membership.delete({ where: { id: invitation.id } });
      return { workspaceId: invitation.workspaceId, role: existing.role };
    }

    await this.prisma.membership.update({
      where: { id: invitation.id },
      data: { userId, status: "active", seatBilled: true },
    });

    await this.audit.record({
      action: A05_AUDIT_ACTIONS.memberInviteAccepted,
      resource: "membership",
      resourceId: invitation.id,
      actorId: userId,
      workspaceId: invitation.workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { role: invitation.role },
    });

    return { workspaceId: invitation.workspaceId, role: invitation.role };
  }

  /** Decline an invitation. The row is removed; the workspace keeps the audit row. */
  async decline(invitationId: string, userId: string, context: RequestContextInfo): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (user === null || user.emailVerifiedAt === null) throw invitationNotFound();

    const invitation = await this.prisma.membership.findFirst({
      where: { id: invitationId, status: "invited", userId: null, invitedEmail: user.email },
      select: { id: true, workspaceId: true, role: true },
    });
    if (invitation === null) throw invitationNotFound();

    await this.prisma.membership.delete({ where: { id: invitation.id } });
    await this.audit.record({
      action: A05_AUDIT_ACTIONS.memberInviteDeclined,
      resource: "membership",
      resourceId: invitation.id,
      actorId: userId,
      workspaceId: invitation.workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
    });
  }

  /**
   * Change a member's role.
   *
   * Two rules the ladder does not express on its own: the owner's role is
   * immutable, and an admin cannot promote anybody past themselves — otherwise
   * "admin" would be a synonym for "owner" reachable in two requests.
   */
  async changeRole(
    workspaceId: string,
    membershipId: string,
    actor: { id: string; role: $Enums.MembershipRole },
    body: ChangeRoleDto,
    context: RequestContextInfo,
  ): Promise<MemberView> {
    const membership = await this.findMember(workspaceId, membershipId);

    if (membership.role === "owner") {
      throw new AppException(
        WORKSPACE_ERRORS.ownerImmutable,
        "The owner's role cannot be changed. Transfer ownership instead.",
        HttpStatus.CONFLICT,
      );
    }
    if (!roleAtLeast(actor.role, body.role)) {
      throw new AppException(
        WORKSPACE_ERRORS.ownerImmutable,
        "You cannot grant a role above your own.",
        HttpStatus.FORBIDDEN,
        { yourRole: actor.role, requestedRole: body.role },
      );
    }

    const updated = await this.prisma.membership.update({
      where: { id: membershipId },
      data: { role: body.role },
      select: MEMBER_SELECT,
    });

    await this.audit.record({
      action: A05_AUDIT_ACTIONS.memberRoleChanged,
      resource: "membership",
      resourceId: membershipId,
      actorId: actor.id,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { before: membership.role, after: body.role, subjectUserId: membership.userId },
    });

    return toMemberView(updated);
  }

  /**
   * Remove a member, or withdraw an invitation.
   *
   * An accepted membership is marked `removed` rather than deleted, so the audit
   * trail and any future seat reconciliation can still see it happened; an
   * invitation nobody took up is deleted, because there is nothing to remember.
   * Every live session that member holds in this workspace is revoked at once —
   * a 15-minute access token would otherwise outlive their access.
   */
  async remove(
    workspaceId: string,
    membershipId: string,
    actor: { id: string; role: $Enums.MembershipRole },
    context: RequestContextInfo,
  ): Promise<{ id: string; status: $Enums.MembershipStatus }> {
    const membership = await this.findMember(workspaceId, membershipId);

    if (membership.role === "owner") {
      throw new AppException(
        WORKSPACE_ERRORS.ownerImmutable,
        "The owner cannot be removed. Transfer ownership or delete the workspace.",
        HttpStatus.CONFLICT,
      );
    }
    if (!roleAtLeast(actor.role, membership.role) && actor.id !== membership.userId) {
      throw new AppException(
        WORKSPACE_ERRORS.ownerImmutable,
        "You cannot remove a member whose role is above your own.",
        HttpStatus.FORBIDDEN,
        { yourRole: actor.role, memberRole: membership.role },
      );
    }

    const now = new Date();
    const status = await this.prisma.withTransaction(async (tx) => {
      if (membership.status === "invited") {
        await tx.membership.delete({ where: { id: membershipId } });
        return "removed" as const;
      }
      await tx.membership.update({
        where: { id: membershipId },
        data: { status: "removed", seatBilled: false },
      });
      if (membership.userId !== null) {
        await tx.session.updateMany({
          where: { workspaceId, userId: membership.userId, revokedAt: null },
          data: { revokedAt: now },
        });
      }
      return "removed" as const;
    });

    await this.audit.record({
      action: A05_AUDIT_ACTIONS.memberRemoved,
      resource: "membership",
      resourceId: membershipId,
      actorId: actor.id,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: {
        role: membership.role,
        subjectUserId: membership.userId,
        wasInvitation: membership.status === "invited",
      },
    });

    return { id: membershipId, status };
  }

  private async findMember(workspaceId: string, membershipId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, workspaceId },
      select: { id: true, userId: true, role: true, status: true },
    });
    if (membership === null || membership.status === "removed") {
      throw new AppException(
        WORKSPACE_ERRORS.memberNotFound,
        "No such member of this workspace.",
        HttpStatus.NOT_FOUND,
      );
    }
    return membership;
  }
}

type MemberRow = {
  id: string;
  userId: string | null;
  role: $Enums.MembershipRole;
  status: $Enums.MembershipStatus;
  seatBilled: boolean;
  invitedEmail: string | null;
  createdAt: Date;
  user: { email: string; name: string | null; avatarUrl: string | null } | null;
};

export function toMemberView(row: MemberRow): MemberView {
  return {
    id: row.id,
    userId: row.userId,
    email: row.user?.email ?? row.invitedEmail,
    name: row.user?.name ?? null,
    avatarUrl: row.user?.avatarUrl ?? null,
    role: row.role,
    status: row.status,
    seatBilled: row.seatBilled,
    createdAt: row.createdAt.toISOString(),
  };
}

function invitationNotFound(): AppException {
  return new AppException(
    WORKSPACE_ERRORS.invitationNotFound,
    "That invitation is not valid, or it was not sent to your address.",
    HttpStatus.NOT_FOUND,
  );
}
