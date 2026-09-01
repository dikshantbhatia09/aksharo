import { CanActivate, HttpStatus, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { type AuthenticatedRequest, roleAtLeast } from "./principal.js";
import { AppException, ERROR_CODES } from "../errors/error-codes.js";

import type { ExecutionContext } from "@nestjs/common";
import type { $Enums } from "@prisma/client";

export const ROLES_KEY = "montaj:roles";

/**
 * The workspace roles allowed on a route. A caller passes when its role is at
 * least as privileged as ANY listed role, so `@Roles("editor")` also admits
 * `admin` and `owner` and route authors do not have to enumerate the ladder.
 */
export const Roles = (...roles: $Enums.MembershipRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Role check against the `role` claim of the access token.
 *
 * The claim is minted by the token endpoints after a membership lookup, so this
 * guard never queries: the token IS the membership assertion, and it lives 15
 * minutes (CONTRACTS §5), which bounds how long a demotion takes to bite.
 * Always used after {@link JwtAuthGuard}, which is what puts the principal there.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<$Enums.MembershipRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;
    if (principal === undefined) {
      throw new AppException(
        ERROR_CODES.unauthorized,
        "Authentication is required.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (required.some((role) => roleAtLeast(principal.role, role))) return true;

    throw new AppException(
      ERROR_CODES.forbidden,
      "Your role does not allow this action.",
      HttpStatus.FORBIDDEN,
      { requiredRole: required },
    );
  }
}
