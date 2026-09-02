import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { normaliseLicenseKey } from "./license-key.util.js";
import { activationsOf, type Activation } from "./license-keys.service.js";
import {
  LICENSE_OFFLINE_MS,
  LICENSING_AUDIT_ACTIONS,
  LICENSING_ERRORS,
  licensingRedisKeys,
  REVOCATION_SNAPSHOT_TTL_SEC,
} from "./licensing.constants.js";
import { SigningService } from "./signing.service.js";
import { DeviceCodeService, TokenService } from "../auth/index.js";
import { AppException, PrismaService, RedisService } from "../common/index.js";
import { DevicesService } from "../devices/devices.service.js";
import { AuditService } from "../users/audit.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { ActivateDto, HeartbeatDto, PluginManifestResponse } from "./licensing.dto.js";

export interface LicenseSnapshotPayload {
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly plan: { readonly key: string; readonly name: string };
  readonly activationLimit: number;
  readonly issuedAt: string;
  readonly exp: string;
  readonly kid: string;
  readonly revocationSerial: number;
}

export interface ActivateResult {
  readonly device: {
    readonly id: string;
    readonly name: string;
    readonly leaseUntil: string | null;
  };
  readonly accessToken?: string;
  readonly expiresIn?: number;
  readonly licenseSnapshot: string;
}

export interface HeartbeatResult {
  readonly leaseUntil: string;
  readonly revocationSerial: number;
  readonly licenseSnapshot: string;
}

/**
 * `POST /plugins/activate` and `POST /plugins/heartbeat` (brief section 3,
 * 07 section Plugins, 05 section 8, THREAT-MODEL T15).
 *
 * Both branches of `activate` converge on the same thing: a `devices` row and
 * a signed, offline-verifiable snapshot (`SigningService`) the caller can keep
 * using for up to 7 days without ever reaching the API again. `heartbeat`
 * renews that lease and hands back the current `revocationSerial` -- a client
 * offline past the window has no way to know if it was revoked, which is
 * exactly what the 7-day cap bounds (05 section 8).
 */
@Injectable()
export class PluginsService {
  private readonly logger = new Logger(PluginsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly signing: SigningService,
    private readonly devices: DevicesService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    private readonly deviceCodes: DeviceCodeService,
    private readonly tokens: TokenService,
  ) {}

  async activate(body: ActivateDto): Promise<ActivateResult> {
    if (body.licenseKey !== undefined) return this.activateWithLicenseKey(body);
    return this.activateWithDeviceCode(body);
  }

  private async activateWithLicenseKey(body: ActivateDto): Promise<ActivateResult> {
    const key = await this.prisma.licenseKey.findUnique({
      where: { key: normaliseLicenseKey(body.licenseKey as string) },
    });
    if (key === null) {
      throw new AppException(
        LICENSING_ERRORS.keyNotFound,
        "No such licence key.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (key.revokedAt !== null) {
      throw new AppException(
        LICENSING_ERRORS.keyRevoked,
        "This licence key was revoked.",
        HttpStatus.FORBIDDEN,
      );
    }

    const activations = activationsOf(key);
    const already = activations.find((a) => a.fingerprint === body.device.fingerprint);
    if (already === undefined && activations.length >= key.maxActivations) {
      throw new AppException(
        LICENSING_ERRORS.activationLimitReached,
        `This licence key allows ${key.maxActivations} activation${key.maxActivations === 1 ? "" : "s"}.`,
        HttpStatus.CONFLICT,
        { maxActivations: key.maxActivations, activations: activations.length },
      );
    }

    const workspace = await this.prisma.workspace.findFirst({
      where: { id: key.workspaceId, deletedAt: null },
      select: { id: true, ownerId: true },
    });
    if (workspace === null) {
      throw new AppException(
        LICENSING_ERRORS.keyNotFound,
        "No such workspace.",
        HttpStatus.NOT_FOUND,
      );
    }

    // A licence key belongs to a workspace, not a signed-in person -- offline
    // activation on a machine with nobody signed into Aksharo at all is exactly
    // what it is for (05 section 8: offline activation). The device is
    // attributed to the workspace owner because `devices.user_id` (06) is NOT
    // NULL and there is no separate "workspace" identity to attribute it to.
    // Flagged as an assumption: 06 does not say who a licence-activated device
    // belongs to.
    const device = await this.devices.register(
      workspace.id,
      workspace.ownerId,
      {
        fingerprint: body.device.fingerprint,
        name: body.device.name,
        platform: body.device.platform,
        host: body.device.host,
        hostVersion: body.device.hostVersion,
        appVersion: body.device.appVersion,
      } as Parameters<typeof this.devices.register>[2],
      {},
    );

    if (already === undefined) {
      const nextActivations: Activation[] = [
        ...activations,
        {
          deviceId: device.id,
          fingerprint: body.device.fingerprint,
          activatedAt: new Date().toISOString(),
        },
      ];
      await this.prisma.licenseKey.update({
        where: { id: key.id },
        data: {
          activations: nextActivations as unknown as object,
          offlineUntil: new Date(Date.now() + LICENSE_OFFLINE_MS),
        },
      });
    }

    const snapshot = await this.snapshotFor(
      workspace.id,
      device.id,
      key.maxActivations,
      key.revocationSerial,
    );

    await this.audit.record({
      action: LICENSING_AUDIT_ACTIONS.activated,
      resource: "device",
      resourceId: device.id,
      workspaceId: workspace.id,
      data: { via: "license_key", licenseKeyId: key.id },
    });

    return {
      device: {
        id: device.id,
        name: device.name,
        leaseUntil: device.leaseUntil?.toISOString() ?? null,
      },
      licenseSnapshot: snapshot,
    };
  }

  private async activateWithDeviceCode(body: ActivateDto): Promise<ActivateResult> {
    // Reuses the exact same device-grant redemption POST /auth/device/token
    // does (DeviceCodeService.poll) -- no forked state machine. A caller that
    // polls too soon gets that method's own authorization_pending error.
    const issued = await this.deviceCodes.poll(body.deviceCode as string, {});
    const claims = await this.tokens.verifyAccessToken(issued.accessToken);

    const device = await this.devices.register(
      issued.workspaceId,
      claims.sub,
      {
        fingerprint: body.device.fingerprint,
        name: body.device.name,
        platform: body.device.platform,
        host: body.device.host,
        hostVersion: body.device.hostVersion,
        appVersion: body.device.appVersion,
      } as Parameters<typeof this.devices.register>[2],
      {},
    );

    await this.prisma.session.update({
      where: { id: issued.sessionId },
      data: { deviceId: device.id },
    });

    const snapshot = await this.snapshotFor(issued.workspaceId, device.id, 1, 0);

    await this.audit.record({
      action: LICENSING_AUDIT_ACTIONS.activated,
      resource: "device",
      resourceId: device.id,
      actorId: claims.sub,
      workspaceId: issued.workspaceId,
      data: { via: "device_code" },
    });

    return {
      device: {
        id: device.id,
        name: device.name,
        leaseUntil: device.leaseUntil?.toISOString() ?? null,
      },
      accessToken: issued.accessToken,
      expiresIn: issued.expiresIn,
      licenseSnapshot: snapshot,
    };
  }

  async heartbeat(body: HeartbeatDto): Promise<HeartbeatResult> {
    const device = await this.prisma.device.findUnique({ where: { id: body.deviceId } });
    if (device === null) {
      throw new AppException(LICENSING_ERRORS.keyNotFound, "No such device.", HttpStatus.NOT_FOUND);
    }
    if (device.revokedAt !== null) {
      throw new AppException(
        LICENSING_ERRORS.deviceRevoked,
        "This device was revoked. Sign in again to reactivate.",
        HttpStatus.FORBIDDEN,
      );
    }

    let revocationSerial = 0;
    let maxActivations = 1;
    if (body.licenseKey !== undefined) {
      const key = await this.prisma.licenseKey.findUnique({
        where: { key: normaliseLicenseKey(body.licenseKey) },
      });
      if (key === null) {
        throw new AppException(
          LICENSING_ERRORS.keyNotFound,
          "No such licence key.",
          HttpStatus.NOT_FOUND,
        );
      }
      if (key.revokedAt !== null) {
        throw new AppException(
          LICENSING_ERRORS.keyRevoked,
          "This licence key was revoked.",
          HttpStatus.FORBIDDEN,
        );
      }
      revocationSerial = key.revocationSerial;
      maxActivations = key.maxActivations;
      await this.prisma.licenseKey.update({
        where: { id: key.id },
        data: { offlineUntil: new Date(Date.now() + LICENSE_OFFLINE_MS) },
      });
    }

    // Nonce dedup: THREAT-MODEL T15's "heartbeat nonce" -- the same nonce
    // replayed (a captured request, resent) renews nothing a second time.
    // Fails open on a Redis outage, the same trade-off auth's poll-interval
    // enforcement makes: a missed replay check must not strand every
    // legitimate plugin offline.
    try {
      const accepted = await this.redis.client.set(
        licensingRedisKeys.heartbeatNonce(device.id, body.nonce),
        "1",
        "EX",
        60 * 60,
        "NX",
      );
      if (accepted === null) {
        throw new AppException(
          LICENSING_ERRORS.nonceReused,
          "That heartbeat was already recorded.",
          HttpStatus.CONFLICT,
        );
      }
    } catch (error) {
      if (error instanceof AppException) throw error;
      this.logger.warn({ err: error }, "heartbeat nonce dedup unavailable; Redis unreachable");
    }

    const leaseUntil = new Date(Date.now() + LICENSE_OFFLINE_MS);
    await this.prisma.device.update({
      where: { id: device.id },
      data: { leaseUntil, lastActiveAt: new Date() },
    });

    const snapshot = await this.snapshotFor(
      device.workspaceId,
      device.id,
      maxActivations,
      revocationSerial,
    );

    await this.audit.record({
      action: LICENSING_AUDIT_ACTIONS.heartbeat,
      resource: "device",
      resourceId: device.id,
      workspaceId: device.workspaceId,
    });

    return { leaseUntil: leaseUntil.toISOString(), revocationSerial, licenseSnapshot: snapshot };
  }

  /**
   * A signed daily snapshot of every revoked licence key's `revocationSerial`
   * and every revoked device id, cached in Redis for 24 hours (brief section
   * 3: "a signed daily snapshot for offline clients") -- a client that has
   * been offline the whole 7-day lease still learns of a revocation the
   * moment it next reaches any surface that can hand it this file, without a
   * live API call for every device it might be asking about.
   */
  async revocationSnapshot(): Promise<string> {
    const cacheKey = licensingRedisKeys.revocationSnapshot();
    try {
      const cached = await this.redis.client.get(cacheKey);
      if (cached !== null) return cached;
    } catch (error) {
      this.logger.warn({ err: error }, "revocation snapshot cache unavailable; recomputing");
    }

    const [revokedKeys, revokedDevices] = await Promise.all([
      this.prisma.licenseKey.findMany({
        where: { revokedAt: { not: null } },
        select: { key: true, revocationSerial: true },
      }),
      this.prisma.device.findMany({
        where: { revokedAt: { not: null } },
        select: { id: true },
      }),
    ]);

    const issuedAt = new Date();
    const payload = {
      issuedAt: issuedAt.toISOString(),
      exp: new Date(issuedAt.getTime() + REVOCATION_SNAPSHOT_TTL_SEC * 1000).toISOString(),
      kid: this.signing.kid,
      revokedKeys: revokedKeys.map((k) => ({ key: k.key, revocationSerial: k.revocationSerial })),
      revokedDeviceIds: revokedDevices.map((d) => d.id),
    };
    const snapshot = this.signing.sign(payload);

    try {
      await this.redis.client.set(cacheKey, snapshot, "EX", REVOCATION_SNAPSHOT_TTL_SEC);
    } catch (error) {
      this.logger.warn({ err: error }, "could not cache the revocation snapshot");
    }

    return snapshot;
  }

  /**
   * `GET /plugins/manifest` (07 §Plugins, D65 change note "07
   * /plugins/manifest"): the channel manifest the plugins page and the
   * installer download links read. C10 (installer builds and hosting) has
   * not landed, so every channel is reported `available: false` with no
   * download URL rather than a channel that resolves to nothing — the same
   * "unavailable until X" convention `client/not_implemented` uses on the
   * web side, expressed in this route's own response shape instead of an
   * error, since a plugin polling this route needs a manifest object back,
   * not a failure.
   */
  manifest(): PluginManifestResponse {
    const unavailable = {
      available: false,
      version: null,
      minHostVersion: null,
      maxHostVersion: null,
      downloadUrl: null,
    } as const;
    return {
      channels: {
        "premiere-uxp": { ...unavailable },
        "ae-cep": { ...unavailable },
        "resolve-script": { ...unavailable },
      },
    };
  }

  private async snapshotFor(
    workspaceId: string,
    deviceId: string,
    activationLimit: number,
    revocationSerial: number,
  ): Promise<string> {
    const entitlement = await this.entitlements.forWorkspace(workspaceId);
    const issuedAt = new Date();
    const payload: LicenseSnapshotPayload = {
      workspaceId,
      deviceId,
      plan: { key: entitlement.planKey, name: entitlement.planName },
      activationLimit,
      issuedAt: issuedAt.toISOString(),
      exp: new Date(issuedAt.getTime() + LICENSE_OFFLINE_MS).toISOString(),
      kid: this.signing.kid,
      revocationSerial,
    };
    return this.signing.sign(payload as unknown as Record<string, unknown>);
  }
}
