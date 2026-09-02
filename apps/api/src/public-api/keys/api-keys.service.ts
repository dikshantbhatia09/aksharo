import { randomBytes } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { CommonAuditService } from "../../common/audit/audit.service.js";
import { hashApiKeySecret } from "../../common/guards/api-key.guard.js";
import { AppException, PrismaService } from "../../common/index.js";
import { EntitlementService } from "../../workspaces/entitlement.service.js";
import {
  API_ENTITLEMENT_FLAG,
  API_KEY_AGENCY_BURST_LIMIT,
  API_KEY_AGENCY_RATE_LIMIT,
  API_KEY_DEFAULT_BURST_LIMIT,
  API_KEY_DEFAULT_RATE_LIMIT,
  API_KEY_ROTATION_OVERLAP_MS,
  PUBLIC_API_ERRORS,
} from "../public-api.constants.js";

import type { $Enums, ApiKey } from "@prisma/client";

export type ApiKeyScope = $Enums.ApiKeyScope;

export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly rateLimit: number;
  readonly burstLimit: number;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface MintedApiKeyView extends ApiKeyView {
  /** `ak_live_<prefix>.<secret>` (A04's `ApiKeyGuard` contract) — shown once. */
  readonly key: string;
}

/** Never real admin/billing scopes: the enum itself (`ApiKeyScope` in schema.prisma) enforces this. */
export const AVAILABLE_API_KEY_SCOPES: readonly ApiKeyScope[] = [
  "projects_read",
  "projects_write",
  "transcripts_read",
  "exports_write",
  "webhooks_manage",
];

/**
 * API key issuance/rotation/revocation (B14 §1) — the workspace-session side of
 * `ApiKeyGuard` (A04, `common/guards/api-key.guard.ts`), which is the
 * *authentication* half this service's rows drive.
 *
 * **Key shape**, per the orchestrator addendum after A04: the guard expects
 * `<prefix>.<secret>` with `sha256(secret)` in `api_keys.hash`. This mints
 * exactly that — `ak_live_<random-prefix>.<random-secret>` — never a server
 * pepper, so the guard did not need to change for it.
 *
 * **Entitlement.** `apiAccess` (Studio/Agency only, `EntitlementService`) gates
 * minting a *new* key; it does not retroactively revoke one if a workspace
 * downgrades — `ApiKeyGuard` has no entitlement check of its own and adding one
 * there is a bigger, separate decision than this WP's to make silently.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    private readonly audit: CommonAuditService,
  ) {}

  async create(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly name: string;
    readonly scopes: readonly ApiKeyScope[];
    readonly expiresAt?: Date;
  }): Promise<MintedApiKeyView> {
    await this.assertEntitled(input.workspaceId);
    const limits = await this.rateLimitFor(input.workspaceId);

    const prefix = `ak_live_${randomBytes(9).toString("hex")}`;
    const secret = randomBytes(24).toString("hex");
    const row = await this.prisma.apiKey.create({
      data: {
        id: ulid(),
        workspaceId: input.workspaceId,
        name: input.name,
        prefix,
        hash: hashApiKeySecret(secret),
        scopes: [...input.scopes],
        rateLimit: limits.rateLimit,
        burstLimit: limits.burstLimit,
        createdBy: input.userId,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      },
    });

    await this.audit.record({
      action: "public_api.key.created",
      resource: "api_key",
      resourceId: row.id,
      actorId: input.userId,
      workspaceId: input.workspaceId,
      data: { name: input.name, scopes: input.scopes, prefix },
    });

    return { ...toView(row), key: `${prefix}.${secret}` };
  }

  async list(workspaceId: string): Promise<readonly ApiKeyView[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toView);
  }

  /**
   * Rotate: mint a fresh key, and give the old one a 24h overlap window rather
   * than revoking it outright (brief §1) — `ApiKeyGuard` refuses it once
   * `expiresAt` passes, no separate "grace" concept needed on the guard side.
   */
  async rotate(workspaceId: string, userId: string, keyId: string): Promise<MintedApiKeyView> {
    const existing = await this.require(workspaceId, keyId);
    if (existing.revokedAt !== null) {
      throw new AppException(
        PUBLIC_API_ERRORS.keyNotFound,
        "This key is already revoked and cannot be rotated.",
        HttpStatus.CONFLICT,
      );
    }

    const minted = await this.create({
      workspaceId,
      userId,
      name: existing.name,
      scopes: existing.scopes,
    });

    await this.prisma.apiKey.update({
      where: { id: existing.id },
      data: { expiresAt: new Date(Date.now() + API_KEY_ROTATION_OVERLAP_MS) },
    });
    await this.prisma.apiKey.update({
      where: { id: minted.id },
      data: { rotatedFrom: existing.id },
    });

    await this.audit.record({
      action: "public_api.key.rotated",
      resource: "api_key",
      resourceId: existing.id,
      actorId: userId,
      workspaceId,
      data: { newKeyId: minted.id, overlapMs: API_KEY_ROTATION_OVERLAP_MS },
    });

    return minted;
  }

  async revoke(workspaceId: string, userId: string, keyId: string): Promise<ApiKeyView> {
    const existing = await this.require(workspaceId, keyId);
    const row = await this.prisma.apiKey.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      action: "public_api.key.revoked",
      resource: "api_key",
      resourceId: existing.id,
      actorId: userId,
      workspaceId,
    });

    return toView(row);
  }

  private async require(workspaceId: string, keyId: string): Promise<ApiKey> {
    const row = await this.prisma.apiKey.findFirst({ where: { id: keyId, workspaceId } });
    if (row === null) {
      throw new AppException(
        PUBLIC_API_ERRORS.keyNotFound,
        "No such API key.",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private async assertEntitled(workspaceId: string): Promise<void> {
    const entitlement = await this.entitlements.forWorkspace(workspaceId);
    if (entitlement.entitlements[API_ENTITLEMENT_FLAG] !== true) {
      throw new AppException(
        PUBLIC_API_ERRORS.entitlementRequired,
        "The public API is available on the Studio and Agency plans.",
        HttpStatus.PAYMENT_REQUIRED,
        { requiredEntitlement: API_ENTITLEMENT_FLAG },
      );
    }
  }

  private async rateLimitFor(
    workspaceId: string,
  ): Promise<{ readonly rateLimit: number; readonly burstLimit: number }> {
    const entitlement = await this.entitlements.forWorkspace(workspaceId);
    return entitlement.planKey === "agency"
      ? { rateLimit: API_KEY_AGENCY_RATE_LIMIT, burstLimit: API_KEY_AGENCY_BURST_LIMIT }
      : { rateLimit: API_KEY_DEFAULT_RATE_LIMIT, burstLimit: API_KEY_DEFAULT_BURST_LIMIT };
  }
}

function toView(row: ApiKey): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    rateLimit: row.rateLimit,
    burstLimit: row.burstLimit,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
