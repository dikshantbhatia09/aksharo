import { CanActivate, ExecutionContext, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { ADMIN_ROLES_KEY } from "./admin-roles.decorator.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { clientIp } from "../common/guards/principal.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

import type { AuthenticatedRequest } from "../common/guards/principal.js";
import type { $Enums } from "@prisma/client";

/** The admin principal a controller acts as. */
export interface AdminPrincipal {
  readonly userId: string;
  /** The workspace the token was minted for. Admin routes are NOT scoped to it. */
  readonly workspaceId: string;
  readonly roles: readonly $Enums.AdminRoleName[];
  readonly ip?: string | undefined;
}

/**
 * Gate for `/admin/**`: a valid `kind: "admin"` access token (CONTRACTS §5,
 * amended 2026-09-03 after B13), minted only by `POST /admin/auth/step-up`
 * after a TOTP check, plus — when the route declares {@link AdminRoles} — a
 * matching, non-revoked `admin_roles` row for this user (THREAT-MODEL T20).
 *
 * Three properties are deliberate.
 *
 * **It requires `kind: "admin"`, not merely `users.is_admin`.** A regular
 * `web`/`desktop` session token, however privileged its owner, must not open
 * `/admin/**` — that is exactly what step-up buys: a 30-minute, TOTP-gated,
 * never-refreshable credential that is a different token than the one sitting
 * in a browser tab. `AccessTokenClaims.kind` is the frozen CONTRACTS §5 field;
 * `/admin/*` accepts nothing else, per that contract's own words.
 *
 * **Role membership is re-read from the database, not trusted from the JWT's
 * `adminRoles` claim.** The claim is what the UI uses to decide what to show;
 * the guard re-checks `admin_roles` so a role revoked mid-session (or the
 * whole grant) takes effect on the very next request rather than waiting out
 * the 30-minute token — the same trade the original (pre-B13) `AdminGuard`
 * made for `is_admin`, preserved here at finer grain.
 *
 * **`superadmin` always satisfies any `@AdminRoles(...)`.** It is the one role
 * the brief marks as a superset (scope §4: "superadmin-only: role management,
 * routing weights, flags global changes" — implying every narrower role-gated
 * route is also open to it).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  constructor(
    private readonly jwt: JwtAuthGuard,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!(await this.jwt.canActivate(context))) return false;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;
    if (principal === undefined) {
      throw new AppException(
        ERROR_CODES.unauthorized,
        "Authentication is required.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (principal.kind !== "admin") {
      this.logger.warn(
        { userId: principal.userId, kind: principal.kind, path: request.path },
        "non-admin token used against an admin route",
      );
      throw new AppException(
        ERROR_CODES.forbidden,
        "This endpoint requires an admin session (POST /admin/auth/step-up).",
        HttpStatus.FORBIDDEN,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: principal.userId },
      select: { id: true, deletedAt: true },
    });
    if (user === null || user.deletedAt !== null) {
      throw new AppException(
        ERROR_CODES.forbidden,
        "This endpoint is restricted to administrators.",
        HttpStatus.FORBIDDEN,
      );
    }

    const required = this.reflector.getAllAndOverride<readonly $Enums.AdminRoleName[] | undefined>(
      ADMIN_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const activeGrants = await this.prisma.adminRole.findMany({
      where: { userId: principal.userId, revokedAt: null },
      select: { role: true },
    });
    const activeRoles = new Set(activeGrants.map((g) => g.role));

    if (activeRoles.size === 0) {
      throw new AppException(
        ERROR_CODES.forbidden,
        "This admin account holds no active roles.",
        HttpStatus.FORBIDDEN,
      );
    }

    if (required !== undefined && required.length > 0) {
      const satisfied = activeRoles.has("superadmin") || required.some((r) => activeRoles.has(r));
      if (!satisfied) {
        this.logger.warn(
          { userId: principal.userId, required, held: [...activeRoles], path: request.path },
          "admin role check failed",
        );
        throw new AppException(
          ERROR_CODES.forbidden,
          `This action requires one of: ${required.join(", ")}.`,
          HttpStatus.FORBIDDEN,
        );
      }
    }

    request.adminActiveRoles = [...activeRoles];
    return true;
  }
}

/** The acting admin, for the audit trail. Call after {@link AdminGuard} has run. */
export function adminOf(request: AuthenticatedRequest): AdminPrincipal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new AppException(
      ERROR_CODES.unauthorized,
      "Authentication is required.",
      HttpStatus.UNAUTHORIZED,
    );
  }
  return {
    userId: principal.userId,
    workspaceId: principal.workspaceId,
    roles: request.adminActiveRoles ?? principal.adminRoles ?? [],
    ip: clientIp(request),
  };
}
