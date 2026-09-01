import { Injectable } from "@nestjs/common";

import { PrismaService } from "../common/prisma/prisma.service.js";

import type { AccessTokenClaims } from "./auth/access-token.js";
import type { ParsedRoom } from "./realtime.protocol.js";

/** Why a room was refused. Sent to the client; deliberately not specific. */
export type RoomRefusal = "forbidden" | "not_found";

export type RoomDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: RoomRefusal };

const ALLOW: RoomDecision = { allowed: true };

/**
 * May this connection join this room?
 *
 * Two independent checks, both required (THREAT-MODEL T4, T5):
 *
 * 1. **The token's workspace.** `workspace:{id}` is joinable only when `id` is the
 *    `ws` claim, and `project:{id}` only when the project belongs to it. The
 *    workspace is never taken from the room name the client asked for — the room
 *    name is the *request*, the claim is the *authority*.
 * 2. **A live membership.** The token is valid for 15 minutes, so a member removed
 *    a minute ago still holds one; the membership row is what says they are still
 *    in the workspace.
 *
 * A soft-deleted workspace or project is `not_found`, so a removed member cannot
 * probe for the existence of a project id.
 */
@Injectable()
export class RoomAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async canJoin(claims: AccessTokenClaims, room: ParsedRoom): Promise<RoomDecision> {
    if (room.kind === "workspace") {
      if (room.id !== claims.ws) return { allowed: false, reason: "forbidden" };
      return (await this.isActiveMember(claims.sub, claims.ws))
        ? ALLOW
        : { allowed: false, reason: "forbidden" };
    }

    const project = await this.prisma.project.findFirst({
      where: { id: room.id, deletedAt: null },
      select: { workspaceId: true },
    });
    // A project in another workspace and a project that does not exist answer the
    // same way, so the room name cannot be used to enumerate ids.
    if (project === null || project.workspaceId !== claims.ws) {
      return { allowed: false, reason: "not_found" };
    }
    return (await this.isActiveMember(claims.sub, claims.ws))
      ? ALLOW
      : { allowed: false, reason: "forbidden" };
  }

  private async isActiveMember(userId: string, workspaceId: string): Promise<boolean> {
    const membership = await this.prisma.membership.findFirst({
      where: { workspaceId, userId, status: "active" },
      select: { id: true },
    });
    return membership !== null;
  }
}
