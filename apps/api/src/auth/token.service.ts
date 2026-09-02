import { createPrivateKey, createPublicKey, createSign, createVerify } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ulid } from "ulid";
import { z } from "zod";

import type { Env } from "@montaj/config";

import { ACCESS_TOKEN_TTL_SEC, AUTH_ERRORS } from "./auth.constants.js";
import { AppException, ERROR_CODES } from "../common/index.js";
import { ENV } from "../config/config.module.js";

import type { AccessTokenClaims, AccessTokenVerifier } from "../common/guards/index.js";
import type { $Enums } from "@prisma/client";
import type { KeyObject } from "node:crypto";

/**
 * CONTRACTS §5 claim set, plus the registered `iss`.
 *
 * `iss` is not in the frozen list because the list names the *product* claims;
 * pinning the issuer costs nothing and stops a token minted by a different
 * environment (staging, a developer's laptop) from being accepted in production.
 */
const ADMIN_ROLE_NAMES = ["support", "finance", "ops", "content", "superadmin"] as const;

const claimsSchema = z.object({
  sub: z.string().min(1),
  ws: z.string().min(1),
  role: z.enum(["owner", "admin", "editor", "viewer"]),
  kind: z.enum(["web", "desktop", "bridge", "premiere", "ae", "resolve", "api", "admin"]),
  jti: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  iss: z.string().min(1),
  adminRoles: z.array(z.enum(ADMIN_ROLE_NAMES)).optional(),
});

/** CONTRACTS §5: 15 minutes for every kind except `"admin"`, which gets 30. */
const ADMIN_ACCESS_TOKEN_TTL_SEC = 30 * 60;

export interface MintAccessTokenInput {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: $Enums.MembershipRole;
  readonly kind: $Enums.ClientKind;
  /** Reuses the session's id when the caller wants the two correlated. */
  readonly jti?: string;
  /** Required, and only honoured, when `kind === "admin"` (B13 step-up). */
  readonly adminRoles?: readonly $Enums.AdminRoleName[];
}

export interface MintedAccessToken {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly jti: string;
  readonly claims: AccessTokenClaims;
}

const base64urlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/**
 * RS256 access tokens, signed and verified with `node:crypto` alone.
 *
 * No JWT library: the whole of what we need is a JWS compact serialisation with
 * one algorithm, and a hand-rolled forty lines that only ever accepts `RS256` is
 * easier to audit than a general-purpose verifier whose `alg` handling is the
 * classic source of confusion attacks. The algorithm is checked against a literal
 * before the signature is verified, so `alg: none` and HMAC confusion cannot arise.
 *
 * Keys come from `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` (CONTRACTS §1) and are
 * parsed lazily, so a service that never signs a token (a test harness, a worker)
 * boots without a usable key pair.
 */
@Injectable()
export class TokenService implements AccessTokenVerifier {
  private privateKey?: KeyObject;
  private publicKey?: KeyObject;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** The `iss` claim: this deployment's API origin. */
  get issuer(): string {
    return this.env.API_ORIGIN;
  }

  mintAccessToken(input: MintAccessTokenInput): MintedAccessToken {
    if (
      input.kind === "admin" &&
      (input.adminRoles === undefined || input.adminRoles.length === 0)
    ) {
      throw new AppException(
        ERROR_CODES.forbidden,
        "An admin token must carry at least one admin role.",
        HttpStatus.FORBIDDEN,
      );
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    const ttl = input.kind === "admin" ? ADMIN_ACCESS_TOKEN_TTL_SEC : ACCESS_TOKEN_TTL_SEC;
    const claims: AccessTokenClaims = {
      sub: input.userId,
      ws: input.workspaceId,
      role: input.role,
      kind: input.kind,
      jti: input.jti ?? ulid(),
      iat: issuedAt,
      exp: issuedAt + ttl,
      iss: this.issuer,
      ...(input.kind === "admin" ? { adminRoles: input.adminRoles } : {}),
    };

    const signingInput = `${base64urlJson({ alg: "RS256", typ: "JWT" })}.${base64urlJson(claims)}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput, "utf8")
      .sign(this.signingKey())
      .toString("base64url");

    return {
      accessToken: `${signingInput}.${signature}`,
      expiresIn: ttl,
      jti: claims.jti,
      claims,
    };
  }

  /**
   * Verify signature, algorithm, issuer and expiry, in that order.
   *
   * Rejects with `auth/expired` when only the lifetime failed, so a client knows
   * to refresh; every other failure is an indistinguishable `common/unauthorized`.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const parts = token.split(".");
    if (parts.length !== 3) throw invalidToken();
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      throw invalidToken();
    }

    // Checked BEFORE the signature: an attacker must not be able to pick the
    // algorithm the verifier uses.
    if (
      typeof header !== "object" ||
      header === null ||
      (header as Record<string, unknown>)["alg"] !== "RS256"
    ) {
      throw invalidToken();
    }

    const signatureValid = createVerify("RSA-SHA256")
      .update(`${encodedHeader}.${encodedPayload}`, "utf8")
      .verify(this.verificationKey(), Buffer.from(encodedSignature, "base64url"));
    if (!signatureValid) throw invalidToken();

    const parsed = claimsSchema.safeParse(payload);
    if (!parsed.success) throw invalidToken();
    if (parsed.data.iss !== this.issuer) throw invalidToken();

    if (parsed.data.exp <= Math.floor(Date.now() / 1000)) {
      throw new AppException(
        AUTH_ERRORS.expired,
        "The access token has expired.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    return parsed.data;
  }

  private signingKey(): KeyObject {
    this.privateKey ??= createPrivateKey(this.env.JWT_PRIVATE_KEY);
    return this.privateKey;
  }

  private verificationKey(): KeyObject {
    this.publicKey ??= createPublicKey(this.env.JWT_PUBLIC_KEY);
    return this.publicKey;
  }
}

function invalidToken(): AppException {
  return new AppException(
    ERROR_CODES.unauthorized,
    "The access token is not valid.",
    HttpStatus.UNAUTHORIZED,
  );
}
