import { CanActivate, HttpStatus, Inject, Injectable } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { AppException, ERROR_CODES, PrismaService } from "../common/index.js";
import { ENV } from "../config/config.module.js";
import { normaliseEmail } from "../users/users.service.js";

import type { AuthenticatedRequest } from "../common/guards/index.js";
import type { ExecutionContext } from "@nestjs/common";

/**
 * `FEATURE_FLAGS_JSON` key holding the platform administrators' addresses:
 * `{"privacy.platformAdmins": ["admin@aksharo.ai"]}`.
 */
export const PLATFORM_ADMINS_FLAG = "privacy.platformAdmins";

/**
 * A stop-gap platform-administrator check.
 *
 * There is no platform admin in the data model: `memberships.role` is scoped to a
 * workspace, and the separate admin application with its own guard, MFA and
 * least-privilege roles is B13 (THREAT-MODEL T20). One route needs the concept
 * before then — the parental waiting list, which belongs to nobody's workspace —
 * so it is authorised from the CONTRACTS §1 flag blob rather than by inventing a
 * column or an environment variable that B13 would have to unpick.
 *
 * Deliberately **closed by default**: with no flag set, nobody is an
 * administrator and the route is 403 for everyone. An allow-list that defaults to
 * "everyone" is how a staging deployment leaks a list of minors' addresses.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

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

    const allowed = platformAdmins(this.env.FEATURE_FLAGS_JSON);
    if (allowed.size === 0) throw forbidden();

    const user = await this.prisma.user.findUnique({
      where: { id: principal.userId },
      select: { email: true, deletedAt: true },
    });
    if (user === null || user.deletedAt !== null || !allowed.has(normaliseEmail(user.email))) {
      throw forbidden();
    }
    return true;
  }
}

/** The allow-list, normalised. Anything that is not an array of strings is empty. */
export function platformAdmins(flags: Record<string, unknown>): ReadonlySet<string> {
  const raw = flags[PLATFORM_ADMINS_FLAG];
  if (!Array.isArray(raw)) return new Set();
  return new Set(
    raw.filter((entry): entry is string => typeof entry === "string").map(normaliseEmail),
  );
}

function forbidden(): AppException {
  return new AppException(
    ERROR_CODES.forbidden,
    "This endpoint is for platform administrators.",
    HttpStatus.FORBIDDEN,
  );
}
