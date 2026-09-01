import { CanActivate, ExecutionContext, HttpStatus, Injectable, Logger } from "@nestjs/common";

import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { AccessTokenGuard, principalOf } from "../realtime/auth/access-token.guard.js";

import type { AuthenticatedRequest } from "../realtime/auth/access-token.guard.js";

/** The admin principal a controller acts as. */
export interface AdminPrincipal {
  readonly userId: string;
  /** The workspace the token was minted for. Admin routes are NOT scoped to it. */
  readonly workspaceId: string;
  readonly ip?: string | undefined;
}

/**
 * Gate for `/admin/**`: a valid access token whose `users.is_admin` is true
 * (THREAT-MODEL T20).
 *
 * Two properties are deliberate.
 *
 * **It re-reads the database on every request.** `is_admin` is not in the token
 * claim set (CONTRACTS §5 is frozen and does not carry it), and putting it there
 * would mean a revoked admin keeps their access until their token expires. One
 * indexed primary-key lookup is the price of revocation taking effect immediately.
 *
 * **It is platform staff, not a workspace role.** `memberships.role` says what a
 * user may do inside *their* workspace; this says they may look at everyone's.
 * That is why the DLQ routes are not workspace-scoped and why every action they
 * take writes an `audit_log` row.
 *
 * Composed with {@link AccessTokenGuard} rather than replacing it, so when A04
 * lands its global guard this file only loses its first two lines. A missing or
 * invalid token is 401 from that guard; a valid token belonging to a non-admin is
 * 403 `common/forbidden` — the distinction is safe here because the caller has
 * already proved who they are.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  constructor(
    private readonly tokens: AccessTokenGuard,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.tokens.canActivate(context)) return false;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = principalOf(request);

    const user = await this.prisma.user.findUnique({
      where: { id: principal.sub },
      select: { id: true, isAdmin: true, deletedAt: true },
    });

    if (user === null || user.deletedAt !== null || !user.isAdmin) {
      this.logger.warn(
        { userId: principal.sub, path: request.path },
        "non-admin request to an admin route",
      );
      throw new AppException(
        ERROR_CODES.forbidden,
        "This endpoint is restricted to administrators.",
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }
}

/** The acting admin, for the audit trail. Call after {@link AdminGuard} has run. */
export function adminOf(request: AuthenticatedRequest): AdminPrincipal {
  const principal = principalOf(request);
  return {
    userId: principal.sub,
    workspaceId: principal.ws,
    ip: request.ip,
  };
}
