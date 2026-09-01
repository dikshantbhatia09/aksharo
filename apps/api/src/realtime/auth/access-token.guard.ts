import { CanActivate, ExecutionContext, HttpStatus, Injectable } from "@nestjs/common";

import { AccessTokenService } from "./access-token.service.js";
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { RequestContext } from "../../common/request-context.js";

import type { AccessTokenClaims } from "./access-token.js";
import type { Request } from "express";

/** The authenticated principal, hung off the request for controllers to read. */
export interface AuthenticatedRequest extends Request {
  principal?: AccessTokenClaims;
}

/**
 * Rejects a request without a valid `Authorization: Bearer` access token and binds
 * the caller's workspace into {@link RequestContext}.
 *
 * **Interim**, and deliberately narrow: it is applied per controller
 * (`@UseGuards(AccessTokenGuard)`), never globally, so A04 can introduce the real
 * global guard without two of them fighting. When that lands, the guard on
 * `JobsController` is swapped for A04's and this file goes.
 *
 * The workspace comes from the token's `ws` claim and from nowhere else: a
 * workspace taken from a header is precisely THREAT-MODEL T4.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly tokens: AccessTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // A04's guard may already have run and populated the context; do not re-verify.
    const existing = RequestContext.get();
    if (request.principal === undefined && existing?.workspaceId !== undefined) return true;

    const header = request.headers.authorization;
    const token =
      header !== undefined && header.toLowerCase().startsWith("bearer ")
        ? header.slice(7).trim()
        : "";
    if (token === "") throw unauthorized();

    const claims = this.tokens.tryVerify(token);
    if (claims === undefined) throw unauthorized();

    request.principal = claims;
    RequestContext.setPrincipal({ userId: claims.sub, workspaceId: claims.ws });
    return true;
  }
}

function unauthorized(): AppException {
  return new AppException(
    ERROR_CODES.unauthorized,
    "A valid access token is required.",
    HttpStatus.UNAUTHORIZED,
  );
}

/**
 * The caller's claims, or a 401.
 *
 * A helper rather than a `@Principal()` param decorator: a decorator would be a
 * second thing A04 has to reconcile, and this is one line at the call site.
 */
export function principalOf(request: AuthenticatedRequest): AccessTokenClaims {
  if (request.principal !== undefined) return request.principal;
  const store = RequestContext.get();
  if (store?.workspaceId !== undefined && store.userId !== undefined) {
    return {
      sub: store.userId,
      ws: store.workspaceId,
      role: "member",
      kind: "web",
      jti: "",
      iat: 0,
      exp: 0,
    };
  }
  throw unauthorized();
}
