import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { DEVICE_AUDIT_ACTIONS, DEVICE_ERRORS, DEVICE_LEASE_MS } from "./devices.constants.js";
import { AppException, PrismaService } from "../common/index.js";
import { AuditService } from "../users/audit.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { RegisterDeviceDto } from "./devices.dto.js";
import type { RequestContextInfo } from "../users/profile.service.js";
import type { $Enums, Device } from "@prisma/client";

export interface DeviceView {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly host: $Enums.HostApp;
  readonly hostVersion: string | null;
  readonly appVersion: string | null;
  readonly lastActiveAt: string | null;
  readonly leaseUntil: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  readonly isCurrentSession: boolean;
}

function toView(device: Device, currentDeviceId: string | null): DeviceView {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    host: device.host,
    hostVersion: device.hostVersion,
    appVersion: device.appVersion,
    lastActiveAt: device.lastActiveAt?.toISOString() ?? null,
    leaseUntil: device.leaseUntil?.toISOString() ?? null,
    revokedAt: device.revokedAt?.toISOString() ?? null,
    createdAt: device.createdAt.toISOString(),
    isCurrentSession: device.id === currentDeviceId,
  };
}

/**
 * Device registration and management (brief §2, 07 §Workspaces, THREAT-MODEL
 * T15's device half). Per-plan limits: Free 1, Starter 1, Creator 2, Studio 5,
 * Agency 3 per seat — read from `EntitlementService`, which already multiplies
 * `activeDevices` by the live subscription's billed seats for a `perSeat` plan
 * (B08's own extension of that service), so this file never re-derives the
 * per-seat maths.
 *
 * A device is identified by its `fingerprint`, unique per workspace
 * (`@@unique([workspaceId, fingerprint])`, 06): registering the same
 * fingerprint again (a plugin restarting, a reinstall with the same machine id)
 * refreshes the lease and never counts twice against the limit. Only a genuinely
 * new fingerprint can trip `devices/limit_reached`, whose response carries every
 * revocable (non-revoked) device so the client can offer "sign out one of
 * these" inline, exactly as the brief names the shape.
 */
@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementService,
  ) {}

  async list(workspaceId: string, currentDeviceId: string | null): Promise<DeviceView[]> {
    const devices = await this.prisma.device.findMany({
      where: { workspaceId },
      orderBy: [{ revokedAt: "asc" }, { lastActiveAt: "desc" }],
    });
    return devices.map((device) => toView(device, currentDeviceId));
  }

  /** The limit this workspace's plan allows right now (used by devices and licensing). */
  async limitFor(workspaceId: string): Promise<number> {
    const entitlement = await this.entitlements.forWorkspace(workspaceId);
    const raw = entitlement.entitlements["activeDevices"];
    return typeof raw === "number" ? raw : 1;
  }

  async activeCount(workspaceId: string): Promise<number> {
    return this.prisma.device.count({ where: { workspaceId, revokedAt: null } });
  }

  async register(
    workspaceId: string,
    userId: string,
    body: RegisterDeviceDto,
    context: RequestContextInfo,
  ): Promise<Device> {
    const existing = await this.prisma.device.findUnique({
      where: { workspaceId_fingerprint: { workspaceId, fingerprint: body.fingerprint } },
    });

    if (existing !== null && existing.revokedAt === null) {
      return this.prisma.device.update({
        where: { id: existing.id },
        data: {
          name: body.name,
          platform: body.platform,
          host: body.host,
          hostVersion: body.hostVersion ?? null,
          appVersion: body.appVersion ?? null,
          lastActiveAt: new Date(),
          leaseUntil: new Date(Date.now() + DEVICE_LEASE_MS),
        },
      });
    }

    const limit = await this.limitFor(workspaceId);
    const active = await this.activeCount(workspaceId);
    if (active >= limit) {
      const devices = await this.list(workspaceId, null);
      throw new AppException(
        DEVICE_ERRORS.limitReached,
        `This plan allows ${limit} active device${limit === 1 ? "" : "s"}. Revoke one to add another.`,
        HttpStatus.CONFLICT,
        { limit, active, devices: devices.filter((d) => d.revokedAt === null) },
      );
    }

    const device = await this.prisma.device.upsert({
      where: { workspaceId_fingerprint: { workspaceId, fingerprint: body.fingerprint } },
      create: {
        id: ulid(),
        workspaceId,
        userId,
        fingerprint: body.fingerprint,
        name: body.name,
        platform: body.platform,
        host: body.host,
        hostVersion: body.hostVersion ?? null,
        appVersion: body.appVersion ?? null,
        lastActiveAt: new Date(),
        leaseUntil: new Date(Date.now() + DEVICE_LEASE_MS),
      },
      update: {
        name: body.name,
        platform: body.platform,
        host: body.host,
        hostVersion: body.hostVersion ?? null,
        appVersion: body.appVersion ?? null,
        lastActiveAt: new Date(),
        leaseUntil: new Date(Date.now() + DEVICE_LEASE_MS),
        revokedAt: null,
      },
    });

    await this.audit.record({
      action: DEVICE_AUDIT_ACTIONS.registered,
      resource: "device",
      resourceId: device.id,
      actorId: userId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { host: body.host, platform: body.platform },
    });

    return device;
  }

  async rename(
    workspaceId: string,
    deviceId: string,
    name: string,
    actorId: string,
    context: RequestContextInfo,
  ): Promise<Device> {
    const device = await this.require(workspaceId, deviceId);
    const updated = await this.prisma.device.update({ where: { id: device.id }, data: { name } });

    await this.audit.record({
      action: DEVICE_AUDIT_ACTIONS.renamed,
      resource: "device",
      resourceId: deviceId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { before: device.name, after: name },
    });

    return updated;
  }

  /** Revoke a device: the next heartbeat fails (brief §2). */
  async revoke(
    workspaceId: string,
    deviceId: string,
    actorId: string,
    context: RequestContextInfo,
  ): Promise<Device> {
    const device = await this.require(workspaceId, deviceId);
    if (device.revokedAt !== null) return device;

    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: { revokedAt: new Date() },
    });

    await this.prisma.session.updateMany({
      where: { workspaceId, deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      action: DEVICE_AUDIT_ACTIONS.revoked,
      resource: "device",
      resourceId: deviceId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
    });

    return updated;
  }

  private async require(workspaceId: string, deviceId: string): Promise<Device> {
    const device = await this.prisma.device.findFirst({ where: { id: deviceId, workspaceId } });
    if (device === null) {
      throw new AppException(DEVICE_ERRORS.notFound, "No such device.", HttpStatus.NOT_FOUND);
    }
    return device;
  }
}
