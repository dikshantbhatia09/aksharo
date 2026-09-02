import { createHash, randomBytes } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import {
  TEAMS_AUDIT_ACTIONS,
  TEAMS_ERRORS,
  TRANSFER_CONFIRMATION_TTL_SEC,
} from "./teams.constants.js";
import { AppException, PrismaService, RedisService } from "../../common/index.js";
import { AuditService } from "../../users/audit.service.js";
import { WORKSPACE_NOTIFIER, type WorkspaceNotifier } from "../workspace-notifier.js";

import type { RequestContextInfo } from "../../users/profile.service.js";

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const redisKey = (workspaceId: string): string =>
  `montaj:workspaces:transfer-ownership:${workspaceId}`;

export interface TransferOwnershipResult {
  readonly status: "confirmation_sent" | "transferred";
  readonly workspaceId?: string;
  readonly newOwnerMembershipId?: string;
}

/**
 * Orchestrator addendum (2026-09-02, after A05): `POST
 * /workspaces/{id}/transfer-ownership {toMembershipId}` — A05 made the owner
 * immutable (`workspaces.owner_id` is a `NOT NULL` FK the guard never lets a
 * caller touch) and there was no path off it at all.
 *
 * Two-step, confirmation-token flow rather than re-authentication (which would
 * need a fresh password/OAuth prompt this HTTP-only service has no way to
 * verify): the first call with no `confirmToken` mints a single-use, 10-minute
 * token, stores only its SHA-256 in Redis (the same primitive
 * `auth/tokens.ts` uses for magic links and e-mail verification) and notifies
 * the owner through `WORKSPACE_NOTIFIER` — the workspace's ownership is the
 * single most consequential membership change short of deletion, and an owner
 * whose session was hijacked gets a second channel to notice before it moves.
 * The second call, with that token, executes the transfer atomically: the
 * caller becomes `admin`, the target becomes `owner`, `workspaces.owner_id`
 * moves, and the token is deleted so it cannot be replayed.
 *
 * Sessions are deliberately left alone (brief: "sessions unaffected") — an
 * ownership transfer is a role change, not a security incident that should log
 * either party out.
 */
@Injectable()
export class OwnershipTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    @Inject(WORKSPACE_NOTIFIER) private readonly notifier: WorkspaceNotifier,
  ) {}

  async transfer(
    workspaceId: string,
    ownerId: string,
    toMembershipId: string,
    confirmToken: string | undefined,
    context: RequestContextInfo,
  ): Promise<TransferOwnershipResult> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, ownerId: true, name: true },
    });
    if (workspace === null || workspace.ownerId !== ownerId) {
      throw new AppException(
        TEAMS_ERRORS.notOwner,
        "Only the current owner may transfer ownership.",
        HttpStatus.FORBIDDEN,
      );
    }

    const target = await this.prisma.membership.findFirst({
      where: { id: toMembershipId, workspaceId },
      select: {
        id: true,
        userId: true,
        status: true,
        role: true,
        user: { select: { email: true } },
      },
    });
    if (target === null) {
      throw new AppException(
        TEAMS_ERRORS.membershipNotFound,
        "No such member.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (target.status !== "active" || target.userId === null) {
      throw new AppException(
        TEAMS_ERRORS.membershipNotActive,
        "The new owner must be an active member.",
        HttpStatus.CONFLICT,
      );
    }
    if (target.userId === ownerId) {
      throw new AppException(
        TEAMS_ERRORS.membershipNotActive,
        "That membership already belongs to the current owner.",
        HttpStatus.CONFLICT,
      );
    }

    const key = redisKey(workspaceId);

    if (confirmToken === undefined) {
      const token = randomToken();
      await this.redis.client.set(
        key,
        JSON.stringify({ toMembershipId, tokenHash: sha256Hex(token) }),
        "EX",
        TRANSFER_CONFIRMATION_TTL_SEC,
      );

      const owner = await this.prisma.user.findUnique({
        where: { id: ownerId },
        select: { email: true },
      });
      if (owner !== null) {
        await this.notifier.ownershipTransferRequested({
          to: owner.email,
          workspaceName: workspace.name,
          confirmationToken: token,
        });
      }

      await this.audit.record({
        action: TEAMS_AUDIT_ACTIONS.ownershipTransferConfirmationSent,
        resource: "workspace",
        resourceId: workspaceId,
        actorId: ownerId,
        workspaceId,
        ...(context.ip === undefined ? {} : { ip: context.ip }),
        data: { toMembershipId },
      });

      return { status: "confirmation_sent" };
    }

    const raw = await this.redis.client.get(key);
    if (raw === null) {
      throw new AppException(
        TEAMS_ERRORS.transferTokenInvalid,
        "That confirmation has expired. Start again.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const stored = JSON.parse(raw) as { toMembershipId: string; tokenHash: string };
    if (stored.toMembershipId !== toMembershipId || stored.tokenHash !== sha256Hex(confirmToken)) {
      throw new AppException(
        TEAMS_ERRORS.transferTokenInvalid,
        "That confirmation does not match.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const newOwnerId = target.userId;
    if (newOwnerId === null) {
      throw new AppException(
        TEAMS_ERRORS.membershipNotActive,
        "The new owner must be an active member.",
        HttpStatus.CONFLICT,
      );
    }

    await this.prisma.withTransaction(async (tx) => {
      await tx.workspace.update({ where: { id: workspaceId }, data: { ownerId: newOwnerId } });
      await tx.membership.update({
        where: { workspaceId_userId: { workspaceId, userId: newOwnerId } },
        data: { role: "owner" },
      });
      await tx.membership.update({
        where: { workspaceId_userId: { workspaceId, userId: ownerId } },
        data: { role: "admin" },
      });
    });

    await this.redis.client.del(key);

    await this.audit.record({
      action: TEAMS_AUDIT_ACTIONS.ownershipTransferred,
      resource: "workspace",
      resourceId: workspaceId,
      actorId: ownerId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { fromUserId: ownerId, toUserId: target.userId, toMembershipId },
    });

    return { status: "transferred", workspaceId, newOwnerMembershipId: toMembershipId };
  }
}
