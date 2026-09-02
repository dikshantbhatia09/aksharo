import { createPublicKey, createVerify, timingSafeEqual } from "node:crypto";

/**
 * RS256 access-token verification, exactly the claim set of `docs/CONTRACTS.md` §5.
 *
 * **Interim.** A04 owns authentication and ships the issuer, the refresh-token
 * family and the global guard. A08 lands before it and still has to reject an
 * unauthenticated WebSocket, so this file implements *verification only* — no
 * issuing, no refresh, no session lookup — against the frozen claim set, using
 * `node:crypto` so it adds no dependency A04 might have to reconcile.
 *
 * A06 retired the interim HTTP guard that sat on top of this: every route wears
 * A04's `JwtAuthGuard` now. What survives is verification for the two callers
 * that are not Nest routes — the WebSocket handshake in `realtime.gateway.ts` and
 * the constant-time compare `GET /internal/metrics` uses on its bearer token.
 */

/** `kind` claim: which client the token was minted for (CONTRACTS §5). */
export const TOKEN_KINDS = [
  "web",
  "desktop",
  "bridge",
  "premiere",
  "ae",
  "resolve",
  "api",
] as const;

export type TokenKind = (typeof TOKEN_KINDS)[number];

export interface AccessTokenClaims {
  /** User id. */
  readonly sub: string;
  /** Workspace id. Bound into the token, never taken from a header (T4). */
  readonly ws: string;
  readonly role: string;
  readonly kind: TokenKind;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  /**
   * The B08 device row a `kind: "bridge"` token was minted for (B08b,
   * CONTRACTS §5 amended 2026-09-03). Absent for every other kind.
   */
  readonly deviceId?: string;
}

export class AccessTokenError extends Error {
  public override readonly name = "AccessTokenError";
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
  }
}

interface JwtHeader {
  readonly alg?: unknown;
  readonly typ?: unknown;
}

function decodeSegment(segment: string): unknown {
  // JWT uses base64url; Node accepts it directly.
  const json = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(json);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if (typeof value !== "string" || value === "") {
    throw new AccessTokenError(`Token claim "${name}" is missing.`, "claims");
  }
  return value;
}

function requireNumber(claims: Record<string, unknown>, name: string): number {
  const value = claims[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AccessTokenError(`Token claim "${name}" is missing.`, "claims");
  }
  return value;
}

export interface VerifyOptions {
  /** PEM public key (`JWT_PUBLIC_KEY`). */
  readonly publicKeyPem: string;
  /** Milliseconds of tolerance for clock drift on `exp` and `iat`. */
  readonly clockToleranceMs?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

const DEFAULT_CLOCK_TOLERANCE_MS = 30_000;

/**
 * Verify an RS256 JWT and return its claims.
 *
 * @throws AccessTokenError with a `reason` of `format` | `algorithm` |
 * `signature` | `claims` | `expired`. The reason never reaches the client — it is
 * for the server log — because distinguishing "bad signature" from "expired" to an
 * unauthenticated caller is an oracle.
 */
export function verifyAccessToken(token: string, options: VerifyOptions): AccessTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessTokenError("Malformed token.", "format");
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  let header: unknown;
  let payload: unknown;
  try {
    header = decodeSegment(headerSegment);
    payload = decodeSegment(payloadSegment);
  } catch {
    throw new AccessTokenError("Malformed token.", "format");
  }

  if (!isRecord(header) || !isRecord(payload)) {
    throw new AccessTokenError("Malformed token.", "format");
  }
  if ((header as JwtHeader).alg !== "RS256") {
    // Rejecting anything but RS256 is what closes the `alg: none` and
    // HMAC-with-the-public-key confusion attacks.
    throw new AccessTokenError("Unsupported token algorithm.", "algorithm");
  }

  const signature = Buffer.from(signatureSegment, "base64url");
  const signed = Buffer.from(`${headerSegment}.${payloadSegment}`, "utf8");

  let valid = false;
  try {
    const key = createPublicKey(options.publicKeyPem);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signed);
    verifier.end();
    valid = verifier.verify(key, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new AccessTokenError("Invalid token signature.", "signature");

  const now = (options.now ?? Date.now)();
  const tolerance = options.clockToleranceMs ?? DEFAULT_CLOCK_TOLERANCE_MS;

  const deviceId = payload["deviceId"];

  const claims: AccessTokenClaims = {
    sub: requireString(payload, "sub"),
    ws: requireString(payload, "ws"),
    role: requireString(payload, "role"),
    kind: asTokenKind(requireString(payload, "kind")),
    jti: requireString(payload, "jti"),
    iat: requireNumber(payload, "iat"),
    exp: requireNumber(payload, "exp"),
    ...(typeof deviceId === "string" && deviceId !== "" ? { deviceId } : {}),
  };

  if (claims.exp * 1000 + tolerance < now) {
    throw new AccessTokenError("Token has expired.", "expired");
  }
  if (claims.iat * 1000 - tolerance > now) {
    throw new AccessTokenError("Token is not valid yet.", "claims");
  }

  return claims;
}

function asTokenKind(value: string): TokenKind {
  if ((TOKEN_KINDS as readonly string[]).includes(value)) return value as TokenKind;
  throw new AccessTokenError(`Unknown token kind "${value}".`, "claims");
}

/**
 * Pull the bearer token out of what a WebSocket client can actually send.
 *
 * A browser cannot set headers on a WebSocket handshake, and a token in the query
 * string ends up in every access log and proxy trace (THREAT-MODEL T21). The
 * standard way out is the `Sec-WebSocket-Protocol` header, which a browser *can*
 * set: the client offers `["aksharo.v1", "bearer.<token>"]` and the server echoes
 * back only `aksharo.v1`. Non-browser clients (bridge, desktop, panels) may use a
 * plain `Authorization: Bearer` header instead.
 */
export function extractBearer(input: {
  readonly authorization?: string | undefined;
  readonly subprotocols?: readonly string[];
  readonly bearerPrefix: string;
}): string | undefined {
  const header = input.authorization?.trim();
  if (header !== undefined && header.toLowerCase().startsWith("bearer ")) {
    const token = header.slice(7).trim();
    if (token !== "") return token;
  }
  for (const offered of input.subprotocols ?? []) {
    if (offered.startsWith(input.bearerPrefix)) {
      const token = offered.slice(input.bearerPrefix.length).trim();
      if (token !== "") return token;
    }
  }
  return undefined;
}

/** Constant-time string comparison, for anything token-shaped. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
