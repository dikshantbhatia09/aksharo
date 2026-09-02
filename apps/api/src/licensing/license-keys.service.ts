import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { generateLicenseKey } from "./license-key.util.js";
import { LICENSING_AUDIT_ACTIONS, LICENSING_ERRORS } from "./licensing.constants.js";
import { AppException, PrismaService } from "../common/index.js";
import { AuditService } from "../users/audit.service.js";

import type { CreateLicenseKeyDto } from "./licensing.dto.js";
import type { RequestContextInfo } from "../users/profile.service.js";
import type { LicenseKey } from "@prisma/client";

export interface Activation {
  readonly deviceId: string;
  readonly fingerprint: string;
  readonly activatedAt: string;
}

export interface LicenseKeyView {
  readonly id: string;
  readonly key: string;
  readonly label: string | null;
  readonly maxActivations: number;
  readonly activationCount: number;
  readonly offlineUntil: string | null;
  readonly revokedAt: string | null;
  readonly revocationSerial: number;
  readonly createdAt: string;
}

export function activationsOf(key: LicenseKey): Activation[] {
  return Array.isArray(key.activations) ? (key.activations as unknown as Activation[]) : [];
}

function toView(key: LicenseKey): LicenseKeyView {
  return {
    id: key.id,
    key: key.key,
    label: key.label,
    maxActivations: key.maxActivations,
    activationCount: activationsOf(key).length,
    offlineUntil: key.offlineUntil?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    revocationSerial: key.revocationSerial,
    createdAt: key.createdAt.toISOString(),
  };
}

/**
 * `POST/GET/DELETE /workspaces/{id}/license-keys` (brief §3, 07 §Workspaces):
 * generate, list, revoke. Only the code itself is unique/generated; everything
 * else about verifying it offline lives in `signing.service.ts` and
 * `plugins.service.ts`.
 */
@Injectable()
export class LicenseKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string): Promise<LicenseKeyView[]> {
    const keys = await this.prisma.licenseKey.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return keys.map(toView);
  }

  async create(
    workspaceId: string,
    body: CreateLicenseKeyDto,
    actorId: string,
    context: RequestContextInfo,
  ): Promise<LicenseKeyView> {
    // Collision odds over a 22^12 keyspace are negligible; retry once anyway
    // rather than trust that -- the unique index is what actually protects us.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const key = await this.prisma.licenseKey.create({
          data: {
            id: ulid(),
            workspaceId,
            key: generateLicenseKey(),
            label: body.label ?? null,
            maxActivations: body.maxActivations,
            activations: [],
          },
        });

        await this.audit.record({
          action: LICENSING_AUDIT_ACTIONS.keyCreated,
          resource: "license_key",
          resourceId: key.id,
          actorId,
          workspaceId,
          ...(context.ip === undefined ? {} : { ip: context.ip }),
          data: { maxActivations: body.maxActivations },
        });

        return toView(key);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new AppException(
      LICENSING_ERRORS.invalidRequest,
      "Could not allocate a licence key. Try again.",
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  async revoke(
    workspaceId: string,
    keyId: string,
    actorId: string,
    context: RequestContextInfo,
  ): Promise<LicenseKeyView> {
    const key = await this.require(workspaceId, keyId);
    if (key.revokedAt !== null) return toView(key);

    const updated = await this.prisma.licenseKey.update({
      where: { id: key.id },
      data: { revokedAt: new Date(), revocationSerial: { increment: 1 } },
    });

    await this.prisma.device.updateMany({
      where: {
        workspaceId,
        id: { in: activationsOf(key).map((a) => a.deviceId) },
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      action: LICENSING_AUDIT_ACTIONS.keyRevoked,
      resource: "license_key",
      resourceId: keyId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
    });

    return toView(updated);
  }

  async require(workspaceId: string, keyId: string): Promise<LicenseKey> {
    const key = await this.prisma.licenseKey.findFirst({ where: { id: keyId, workspaceId } });
    if (key === null) {
      throw new AppException(
        LICENSING_ERRORS.keyNotFound,
        "No such licence key.",
        HttpStatus.NOT_FOUND,
      );
    }
    return key;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}
