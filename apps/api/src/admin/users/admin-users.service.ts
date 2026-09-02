import { HttpStatus, Injectable } from "@nestjs/common";

import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";

import type {
  AdminSearchQueryDto,
  AdminUserDetailDto,
  AdminUserSummaryDto,
  AdminWorkspaceDetailDto,
  AdminWorkspaceSummaryDto,
} from "./admin-users.dto.js";

export interface AdminPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/**
 * Cross-tenant search/detail for the admin console (B13 scope §2: "users/
 * workspaces search and detail (plan, credits, devices, jobs, invoices)").
 * Deliberately its own read model rather than reusing `UsersService`/
 * `WorkspacesService` — those are workspace/member-scoped by design (04
 * §Identity & tenancy), and an admin query is the one place that is
 * intentionally NOT scoped to a workspace (`AdminGuard`'s own doc comment).
 */
@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async searchUsers(query: AdminSearchQueryDto): Promise<AdminPage<AdminUserSummaryDto>> {
    const rows = await this.prisma.user.findMany({
      where: {
        ...(query.query === undefined
          ? {}
          : {
              OR: [
                { email: { contains: query.query, mode: "insensitive" } },
                { name: { contains: query.query, mode: "insensitive" } },
              ],
            }),
      },
      orderBy: { id: "asc" },
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      take: query.limit,
    });
    return {
      items: rows.map(toUserSummary),
      ...(rows.length === query.limit ? { nextCursor: rows[rows.length - 1]?.id } : {}),
    };
  }

  async userDetail(userId: string): Promise<AdminUserDetailDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user === null) {
      throw new AppException(ERROR_CODES.notFound, "No such user.", HttpStatus.NOT_FOUND);
    }
    const [memberships, deviceCount, adminRoles] = await Promise.all([
      this.prisma.membership.findMany({
        where: { userId },
        include: { workspace: { select: { id: true, name: true } } },
      }),
      this.prisma.device.count({ where: { userId, revokedAt: null } }),
      this.prisma.adminRole.findMany({
        where: { userId, revokedAt: null },
        select: { role: true },
      }),
    ]);

    return {
      ...toUserSummary(user),
      memberships: memberships
        .filter((m) => m.workspace !== null)
        .map((m) => ({
          workspaceId: m.workspaceId,
          workspaceName: m.workspace.name,
          role: m.role,
          status: m.status,
        })),
      deviceCount,
      adminRoles: adminRoles.map((r) => r.role),
    };
  }

  async searchWorkspaces(query: AdminSearchQueryDto): Promise<AdminPage<AdminWorkspaceSummaryDto>> {
    const rows = await this.prisma.workspace.findMany({
      where: {
        ...(query.query === undefined
          ? {}
          : {
              OR: [
                { name: { contains: query.query, mode: "insensitive" } },
                { slug: { contains: query.query, mode: "insensitive" } },
              ],
            }),
      },
      orderBy: { id: "asc" },
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      take: query.limit,
    });
    return {
      items: rows.map(toWorkspaceSummary),
      ...(rows.length === query.limit ? { nextCursor: rows[rows.length - 1]?.id } : {}),
    };
  }

  async workspaceDetail(workspaceId: string): Promise<AdminWorkspaceDetailDto> {
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (workspace === null) {
      throw new AppException(ERROR_CODES.notFound, "No such workspace.", HttpStatus.NOT_FOUND);
    }
    const [owner, memberCount, creditAccount, subscription] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: workspace.ownerId }, select: { email: true } }),
      this.prisma.membership.count({ where: { workspaceId, status: "active" } }),
      this.prisma.creditAccount.findUnique({ where: { workspaceId } }),
      this.prisma.subscription.findFirst({
        where: { workspaceId, status: { in: ["active", "past_due", "trialing"] } },
        orderBy: { currentPeriodEnd: "desc" },
      }),
    ]);

    return {
      ...toWorkspaceSummary(workspace),
      ...(owner?.email === undefined ? {} : { ownerEmail: owner.email }),
      memberCount,
      ...(creditAccount === null
        ? {}
        : {
            creditAccount: {
              balanceTenths: creditAccount.balanceTenths,
              monthlyGrantTenths: creditAccount.monthlyGrantTenths,
              grantResetAt: creditAccount.grantResetAt?.toISOString() ?? null,
              negativeAllowed: creditAccount.negativeAllowed,
            },
          }),
      ...(subscription === null
        ? {}
        : {
            subscription: {
              planId: subscription.planId,
              status: subscription.status,
              currency: subscription.currency,
              currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            },
          }),
    };
  }
}

function toUserSummary(user: {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  createdAt: Date;
  lastSeenAt: Date | null;
  deletedAt: Date | null;
}): AdminUserSummaryDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    deletedAt: user.deletedAt?.toISOString() ?? null,
  };
}

function toWorkspaceSummary(workspace: {
  id: string;
  slug: string;
  name: string;
  type: string;
  ownerId: string;
  currency: string;
  createdAt: Date;
  deletedAt: Date | null;
}): AdminWorkspaceSummaryDto {
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    type: workspace.type,
    ownerId: workspace.ownerId,
    currency: workspace.currency,
    createdAt: workspace.createdAt.toISOString(),
    deletedAt: workspace.deletedAt?.toISOString() ?? null,
  };
}
