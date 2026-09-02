import { CanActivate, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { AppException, ERROR_CODES } from "../errors/error-codes.js";
import { RequestContext } from "../request-context.js";
import {
  ACCESS_TOKEN_VERIFIER,
  type AccessTokenVerifier,
  type AuthenticatedRequest,
} from "./principal.js";
import { ALLOW_BRIDGE_TOKEN_KEY, IS_PUBLIC_KEY } from "./public.decorator.js";

import type { ExecutionContext } from "@nestjs/common";

/** `Authorization: Bearer <jwt>`, or `undefined` when the header is absent/malformed. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return undefined;
  const token = rest.join(" ").trim();
  return token === "" ? undefined : token;
}

/**
 * Verifies the RS256 access token and attaches the {@link AuthPrincipal}.
 *
 * Not registered globally: `main.ts` binds no `APP_GUARD`, so a route is protected
 * because it says `@UseGuards(JwtAuthGuard)`, which is greppable. `@Public()`
 * exempts a route inside a guarded controller.
 *
 * An expired token is `auth/expired` (07 §Conventions) so the client knows to
 * refresh rather than to send the user back to the login screen; everything else
 * is a flat `common/unauthorized` with no detail about why.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ACCESS_TOKEN_VERIFIER) private readonly verifier: AccessTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) {
      throw new AppException(
        ERROR_CODES.unauthorized,
        "Authentication is required.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    const claims = await this.verifier.verifyAccessToken(token);

    if (claims.kind === "bridge") {
      // B08b (CONTRACTS §5): a bridge token authenticates a local bridge
      // process, not a user at a browser or plugin. It never passes this
      // guard for an ordinary route unless that route opts in with
      // `@AllowBridgeToken()` — nothing does today (see that decorator's
      // comment) so this is a flat refusal in practice.
      const allowBridge = this.reflector.getAllAndOverride<boolean>(ALLOW_BRIDGE_TOKEN_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (allowBridge !== true) {
        throw new AppException(
          ERROR_CODES.forbidden,
          "A bridge credential cannot be used here.",
          HttpStatus.FORBIDDEN,
        );
      }
    }

    request.principal = {
      userId: claims.sub,
      workspaceId: claims.ws,
      role: claims.role,
      kind: claims.kind,
      jti: claims.jti,
      ...(claims.adminRoles !== undefined ? { adminRoles: claims.adminRoles } : {}),
      ...(claims.deviceId !== undefined ? { deviceId: claims.deviceId } : {}),
    };
    RequestContext.setPrincipal({ userId: claims.sub, workspaceId: claims.ws });
    return true;
  }
}
