import { createHash, timingSafeEqual } from "node:crypto";

import { CanActivate, HttpStatus, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { AppException, ERROR_CODES } from "../errors/error-codes.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { RequestContext } from "../request-context.js";
import { type AuthenticatedRequest } from "./principal.js";

import type { ExecutionContext } from "@nestjs/common";
import type { $Enums } from "@prisma/client";

export const API_SCOPES_KEY = "montaj:api-scopes";

/** Scopes a route requires of an `X-Api-Key` caller (all of them must be present). */
export const ApiScopes = (...scopes: $Enums.ApiKeyScope[]): MethodDecorator & ClassDecorator =>
  SetMetadata(API_SCOPES_KEY, scopes);

/** Header carrying a customer API key (07 §Conventions). */
export const API_KEY_HEADER = "x-api-key";

/**
 * Presented key format: `<prefix>.<secret>`.
 *
 * The prefix is stored in clear (`api_keys.prefix`, unique) so a key can be looked
 * up in one indexed query and shown in the UI; only the secret half is hashed.
 * B14 mints the keys — this parser is the contract it must honour.
 */
export function parseApiKey(presented: string): { prefix: string; secret: string } | undefined {
  const separator = presented.indexOf(".");
  if (separator <= 0 || separator === presented.length - 1) return undefined;
  const prefix = presented.slice(0, separator);
  const secret = presented.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(prefix) || !/^[A-Za-z0-9_-]{16,128}$/.test(secret)) {
    return undefined;
  }
  return { prefix, secret };
}

/** SHA-256 of the secret half, hex. Stored in `api_keys.hash`. */
export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Scopes B14 mints that let a key mutate something. Any one of them caps the
 * derived role at `editor`; a key with only read scopes stays `viewer`.
 */
const WRITE_SCOPES: readonly $Enums.ApiKeyScope[] = [
  "projects_write",
  "exports_write",
  "webhooks_manage",
];

/** Compared against when the prefix is unknown, so both paths cost the same. */
const ABSENT_KEY_HASH = createHash("sha256").update("absent", "utf8").digest("hex");

function unauthorizedKey(): AppException {
  return new AppException(
    ERROR_CODES.unauthorized,
    "A valid API key is required.",
    HttpStatus.UNAUTHORIZED,
  );
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * `X-Api-Key` authentication for the public API.
 *
 * A04 ships the guard; B14 ships issuance, rotation and per-key rate limits, so
 * no endpoint wears this guard yet. It is here now because the shape of the key
 * and the scope check are what B14 has to build against, and because the guard is
 * the thing A04's threat-model row for tenant isolation (T4) applies to: the
 * workspace comes from the key record, never from the request.
 *
 * D27: a customer key never carries `admin`. The principal's role is derived from
 * the scopes and is capped at `editor`.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const header = request.headers[API_KEY_HEADER];
    const presented = Array.isArray(header) ? header[0] : header;
    const parsed = presented === undefined ? undefined : parseApiKey(presented);
    if (parsed === undefined) throw unauthorizedKey();

    const record = await this.prisma.apiKey.findUnique({
      where: { prefix: parsed.prefix },
      select: {
        id: true,
        hash: true,
        scopes: true,
        revokedAt: true,
        expiresAt: true,
        workspaceId: true,
        workspace: { select: { ownerId: true, deletedAt: true } },
      },
    });

    // The hash comparison runs even when the prefix is unknown, so a caller
    // cannot distinguish "no such key" from "wrong secret" by timing.
    const candidate = hashApiKeySecret(parsed.secret);
    const stored = record?.hash ?? ABSENT_KEY_HASH;
    const matches = constantTimeEquals(candidate, stored);

    if (record === null || !matches) throw unauthorizedKey();
    if (record.revokedAt !== null || record.workspace.deletedAt !== null) throw unauthorizedKey();
    // B14: a rotated-out key is given a 24h overlap window via `expiresAt`
    // rather than being revoked outright; past that instant it is refused
    // exactly like a revoked one.
    if (record.expiresAt !== null && record.expiresAt.getTime() <= Date.now()) {
      throw unauthorizedKey();
    }

    const requiredScopes = this.reflector.getAllAndOverride<$Enums.ApiKeyScope[] | undefined>(
      API_SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const granted = new Set<$Enums.ApiKeyScope>(record.scopes);
    if (requiredScopes !== undefined && !requiredScopes.every((scope) => granted.has(scope))) {
      throw new AppException(
        ERROR_CODES.forbidden,
        "This API key does not carry the required scope.",
        HttpStatus.FORBIDDEN,
        { requiredScopes },
      );
    }

    request.principal = {
      userId: record.workspace.ownerId,
      workspaceId: record.workspaceId,
      // D27: a customer key is never `admin`; a write scope caps it at `editor`.
      role: WRITE_SCOPES.some((scope) => granted.has(scope)) ? "editor" : "viewer",
      kind: "api",
      jti: record.id,
      apiKeyId: record.id,
      scopes: record.scopes,
    };
    RequestContext.setPrincipal({
      userId: record.workspace.ownerId,
      workspaceId: record.workspaceId,
    });
    return true;
  }
}
