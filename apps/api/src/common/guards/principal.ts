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
  /** Present only for `kind: "bridge"` tokens (B08b, CONTRACTS §5 amended 2026-09-03). */
  readonly deviceId?: string;
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
  /**
   * The B08 device row this token was minted for. Required, and only ever
   * present, when `kind === "bridge"` (B08b, CONTRACTS §5 amended
   * 2026-09-03 after C01): a bridge token without it is not a valid bridge
   * credential, and `TokenService.mintAccessToken` refuses to mint one.
   */
  readonly deviceId?: string;
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
 * How many proxies in front of this process are trusted to have appended to
 * `X-Forwarded-For`, from `TRUST_PROXY`. `0` (or unset) means none.
 *
 * A count and not a boolean, because "trust the header" and "trust the header's
 * left-most value" are very different statements. `X-Forwarded-For` is built by
 * appending: each hop adds the address it received the request *from*, so the
 * right-most entry is the one written by the hop nearest this process — the only
 * entry any of them can vouch for. Everything to the left of the trusted hops was
 * supplied by the client and can say anything.
 */
function trustedProxyHops(): number {
  const raw = process.env["TRUST_PROXY"];
  if (raw === undefined || raw === "") return 0;
  const hops = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(hops) || hops <= 0) return 0;
  return hops;
}

/**
 * The client IP.
 *
 * `X-Forwarded-For` is read **only** when `TRUST_PROXY` says how many proxies the
 * operator controls sit in front of this process, and then only at the position
 * those proxies actually wrote. Trusting the header unconditionally, or taking
 * its left-most value, both hand every attacker a fresh rate-limit bucket per
 * request — which is the same as having no per-IP limit at all (THREAT-MODEL T1,
 * T3; launch-readiness P0-08).
 *
 * Worked example, `TRUST_PROXY=2` (Cloudflare, then the ingress controller) and a
 * request whose header arrives as `9.9.9.9, 203.0.113.7, 10.0.0.5`:
 *
 *   * `10.0.0.5` was written by the ingress — the address it saw, i.e. Cloudflare;
 *   * `203.0.113.7` was written by Cloudflare — the address *it* saw, the client;
 *   * `9.9.9.9` was in the header when it reached Cloudflare: attacker-supplied.
 *
 * Two trusted hops means stepping two entries in from the right, giving
 * `203.0.113.7`. A forged prefix of any length changes nothing, because the
 * position is counted from the end. If the header is shorter than the configured
 * hop count — a request that reached this process without passing every declared
 * proxy, such as one that found the origin directly — there is no trustworthy
 * entry at all, and the socket address is used instead.
 *
 * Never used for authorisation — only for rate limiting, audit rows and the device
 * approval screen. `TRUST_PROXY` is a local process setting, not a CONTRACTS §1
 * variable, so it is read from `process.env` (as `API_PORT` is in `main.ts`).
 */
export function clientIp(request: Request): string {
  const hops = trustedProxyHops();
  if (hops > 0) {
    const forwarded = request.headers["x-forwarded-for"];
    // Express folds a repeated header into an array; the wire order is preserved
    // by joining, so one parse handles both shapes.
    const raw = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const entries = (raw ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");

    // `hops` trusted proxies wrote the last `hops` entries; the client address is
    // the one the outermost trusted proxy recorded.
    const trusted = entries[entries.length - hops];
    if (trusted !== undefined) return trusted;
  }
  return request.ip ?? request.socket?.remoteAddress ?? "unknown";
}

/** User agent, truncated: it is attacker-controlled and lands in the database. */
export function clientUserAgent(request: Request): string | undefined {
  const ua = request.headers["user-agent"];
  return typeof ua === "string" && ua !== "" ? ua.slice(0, 512) : undefined;
}
