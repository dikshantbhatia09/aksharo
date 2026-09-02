import { CanActivate, HttpStatus, Injectable } from "@nestjs/common";

import { WORKSPACE_ERRORS } from "./workspaces.constants.js";
import { AppException, ERROR_CODES, PrismaService } from "../common/index.js";

import type { AuthenticatedRequest } from "../common/guards/index.js";
import type { ExecutionContext } from "@nestjs/common";

/**
 * The membership guard every `/workspaces/:id/*` route wears (THREAT-MODEL T4).
 *
 * Two checks, and both matter:
 *
 * 1. **The id in the path must be the `ws` claim of the access token.** The
 *    workspace context comes from the token and from nowhere else (07
 *    §Conventions: "There is no `X-Workspace-Id` header"), so a path segment is
 *    just another attacker-supplied string. Switching workspace goes through
 *    `POST /auth/token/exchange`, which re-checks membership and mints a new
 *    session. Without this check the path would become the header by another
 *    name, which is precisely T4.
 *
 * 2. **An active membership must still exist.** The `role` claim is a 15-minute
 *    assertion made when the token was minted, so a member removed a minute ago
 *    still carries a token that says otherwise. This guard reads the row, and
 *    replaces the principal's `role` with the one in the database — so
 *    `RolesGuard`, which runs after it, judges the live role rather than the
 *    minted one. A demotion therefore bites on the next request, not in fifteen
 *    minutes.
 *
 * The answer to both failures is **403 `auth/not_a_member`**, never 404: the
 * workspace id is in the caller's own token, so there is nothing to enumerate,
 * and a 404 would make "this workspace does not exist" and "you were removed from
 * it" indistinguishable to a member who was just removed.
 *
 * A06 widened the guard's reach without changing either rule. `/projects/*` is
 * workspace-scoped through the token and has no workspace id in its path, so on a
 * route with no `:id` the guard skips check (1) — there is nothing to compare —
 * and still performs check (2). Before A06 that case returned `true`, which was
 * correct while the only routes wearing the guard were `/workspaces/:id/*`, and
 * would have been a silent hole the moment another controller wore it.
 */
@Injectable()
export class WorkspaceMemberGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;
    if (principal === undefined) {
      throw new AppException(
        ERROR_CODES.unauthorized,
        "Authentication is required.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    // A route with no `:id` in its path is workspace-scoped through the token
    // alone — every `/projects/*` route is (A06), and its `:projectId` is not a
    // workspace id. Check (2) below still applies to those, and only check (1)
    // is skipped, because there is no path segment to compare.
    const pathWorkspaceId = (request.params as Record<string, string | undefined>)["id"];
    const workspaceId = pathWorkspaceId ?? principal.workspaceId;

    if (workspaceId !== principal.workspaceId) throw notAMember();

    const membership = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: principal.userId } },
      select: { role: true, status: true, workspace: { select: { deletedAt: true } } },
    });
    if (
      membership === null ||
      membership.status !== "active" ||
      membership.workspace.deletedAt !== null
    ) {
      throw notAMember();
    }

    request.principal = { ...principal, role: membership.role };
    return true;
  }
}

function notAMember(): AppException {
  return new AppException(
    WORKSPACE_ERRORS.notAMember,
    "You are not a member of that workspace.",
    HttpStatus.FORBIDDEN,
  );
}
