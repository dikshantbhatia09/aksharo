import { createParamDecorator, InternalServerErrorException } from "@nestjs/common";

import { type AuthenticatedRequest, type AuthPrincipal } from "./principal.js";

import type { ExecutionContext } from "@nestjs/common";

function principalOf(context: ExecutionContext): AuthPrincipal {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (request.principal === undefined) {
    // Reaching here means the route forgot `@UseGuards(JwtAuthGuard)`. Failing
    // loudly beats handing the handler `undefined` and letting it query for it.
    throw new InternalServerErrorException("@CurrentUser() used on a route without JwtAuthGuard.");
  }
  return request.principal;
}

/**
 * The authenticated caller.
 *
 * ```ts
 * @Get() list(@CurrentUser() user: AuthPrincipal) { ... }
 * @Get() list(@CurrentUser("userId") userId: string) { ... }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthPrincipal | undefined, context: ExecutionContext): unknown => {
    const principal = principalOf(context);
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    return field === undefined ? principal : principal[field];
  },
);

/**
 * The workspace bound into the access token (CONTRACTS §5).
 *
 * Deliberately not readable from a header or a query parameter — see
 * {@link AuthPrincipal} and THREAT-MODEL T4.
 */
export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => principalOf(context).workspaceId,
);
