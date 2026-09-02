import type { $Enums } from "@prisma/client";
import type { Request } from "express";

/**
 * The authenticated caller, as every guard and controller sees it.
 *
 * `workspaceId` comes from the access token and from nowhere else: THREAT-MODEL T4
 * is tenant confusion, and an `X-Workspace-Id` header is exactly how that happens
 * (07 §Conventions: "There is no `X-Workspace-Id` header"). Switching workspaces
 * goes through `POST /auth/token/exchange`, which re-checks membership.
 */
export interface AuthPrincipal {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: $Enums.MembershipRole;
  readonly kind: $Enums.ClientKind;
  /** Access-token id, so a request can be tied back to the session that made it. */
  readonly jti: string;
  /** Present only for `X-Api-Key` callers (`ApiKeyGuard`). */
  readonly apiKeyId?: string;
  readonly scopes?: readonly $Enums.ApiKeyScope[];
  /** Present only for `kind: "admin"` tokens (B13 step-up, CONTRACTS §5). */
  readonly adminRoles?: readonly $Enums.AdminRoleName[];
}

/** The verified claim set of an access token (CONTRACTS §5). */
export interface AccessTokenClaims {
  readonly sub: string;
  readonly ws: string;
  readonly role: $Enums.MembershipRole;
  readonly kind: $Enums.ClientKind;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
  /** Only present, and only meaningful, when `kind === "admin"`. */
  readonly adminRoles?: readonly $Enums.AdminRoleName[];
}

/**
 * What `JwtAuthGuard` needs from the auth module, as an interface rather than a
 * class, so `common/` never imports `auth/`. `AuthModule` binds the token to its
 * `TokenService` and is `@Global()`, which is what lets any feature module use
 * the guard without importing anything.
 */
export interface AccessTokenVerifier {
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
}

export const ACCESS_TOKEN_VERIFIER = Symbol("ACCESS_TOKEN_VERIFIER");

/** Express request with the principal the guards attach. */
export interface AuthenticatedRequest extends Request {
  principal?: AuthPrincipal;
  /** Set by `AdminGuard` after its database re-check — the source of truth for `adminOf()`. */
  adminActiveRoles?: readonly $Enums.AdminRoleName[];
}

/** Role ranking used by {@link RolesGuard}; `owner` is the most privileged. */
export const ROLE_ORDER: readonly $Enums.MembershipRole[] = ["viewer", "editor", "admin", "owner"];

/** `true` when `role` is at least as privileged as `minimum`. */
export function roleAtLeast(role: $Enums.MembershipRole, minimum: $Enums.MembershipRole): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(minimum);
}

/**
 * The client IP.
 *
 * `X-Forwarded-For` is read **only** when `TRUST_PROXY=1` says an edge the operator
 * controls rewrites it. Trusting it unconditionally would hand every attacker a
 * fresh rate-limit bucket per request, which is the same as having no per-IP limit
 * at all (THREAT-MODEL T1, T3). With no proxy configured the socket address is the
 * only honest answer.
 *
 * Never used for authorisation — only for rate limiting, audit rows and the device
 * approval screen. `TRUST_PROXY` is a local process setting, not a CONTRACTS §1
 * variable, so it is read from `process.env` (as `API_PORT` is in `main.ts`).
 */
export function clientIp(request: Request): string {
  if (process.env["TRUST_PROXY"] === "1") {
    const forwarded = request.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const fromHeader = first?.split(",")[0]?.trim();
    if (fromHeader !== undefined && fromHeader !== "") return fromHeader;
  }
  return request.ip ?? request.socket?.remoteAddress ?? "unknown";
}

/** User agent, truncated: it is attacker-controlled and lands in the database. */
export function clientUserAgent(request: Request): string | undefined {
  const ua = request.headers["user-agent"];
  return typeof ua === "string" && ua !== "" ? ua.slice(0, 512) : undefined;
}
