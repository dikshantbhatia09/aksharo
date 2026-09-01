import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import type { Env } from "@montaj/config";

import { AUTH_AUDIT_ACTIONS, AuthAuditService } from "./auth-audit.service.js";
import {
  AUTH_ERRORS,
  DEVICE_CODE_BYTES,
  DEVICE_CODE_TTL_SEC,
  DEVICE_PENDING_CAP_PER_IP,
  DEVICE_POLL_INTERVAL_SEC,
  DEVICE_SLOW_DOWN_INCREMENT_SEC,
  redisKeys,
} from "./auth.constants.js";
import { SessionService } from "./session.service.js";
import { formatUserCode, generateUserCode, randomToken, sha256Hex } from "./tokens.js";
import { AppException, ERROR_CODES, PrismaService, RedisService } from "../common/index.js";
import { ENV } from "../config/config.module.js";
import { UsersService } from "../users/users.service.js";

import type { CoarseLocation } from "./geo.js";
import type { IssuedTokens } from "./session.service.js";
import type { $Enums, Prisma } from "@prisma/client";

export interface DeviceCodeRequest {
  readonly clientKind: $Enums.ClientKind;
  readonly hostApp?: $Enums.HostApp;
  /** Free-form, shown on the approval screen: OS, app version, machine name. */
  readonly deviceInfo?: Record<string, string>;
  readonly ip?: string;
  readonly location?: CoarseLocation;
}

/** RFC 8628 section 3.2, in this repository's camelCase (CONTRACTS section 5). */
export interface DeviceCodeGrant {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  /** `verificationUrl` with the code filled in, for a QR code on the device. */
  readonly verificationUrlComplete: string;
  readonly interval: number;
  readonly expiresIn: number;
}

export interface PendingApproval {
  readonly userCode: string;
  readonly clientKind: $Enums.ClientKind;
  readonly hostApp: $Enums.HostApp | null;
  readonly deviceInfo: Record<string, unknown>;
  readonly ip: string | null;
  readonly location: CoarseLocation | null;
  readonly expiresAt: Date;
}

/** How many times a colliding user code is regenerated before giving up. */
const USER_CODE_ATTEMPTS = 5;

/**
 * The device grant (RFC 8628 shape; 07 section Auth, THREAT-MODEL T3).
 *
 * A headless client -- a Premiere panel, the desktop app, the local bridge -- asks
 * for a pair of codes, shows the short one to the user, and polls. The user types
 * the short code into an https page they are already signed in to, sees what is
 * asking and from where, and approves. Only then does the device get tokens.
 *
 * The mitigations that make phishing this flow hard are all here: an unambiguous
 * 8-character code, a 10-minute ceiling, a per-address cap on codes in flight, a
 * server-enforced polling interval, and an approval screen with enough context to
 * notice that nothing on your desk is asking for anything.
 *
 * `device_codes.device_code` stores `sha256(deviceCode)`, not the value: the
 * column is a bearer credential and a database dump must not be replayable.
 */
@Injectable()
export class DeviceCodeService {
  private readonly logger = new Logger(DeviceCodeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
    private readonly audit: AuthAuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Where the user is told to go, e.g. `https://app.example/device`. */
  get verificationUrl(): string {
    return new URL("/device", this.env.WEB_ORIGIN).toString();
  }

  async request(input: DeviceCodeRequest): Promise<DeviceCodeGrant> {
    if (input.ip !== undefined) await this.assertUnderPendingCap(input.ip);

    const deviceCode = randomToken(DEVICE_CODE_BYTES);
    const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SEC * 1000);
    const deviceInfo = {
      ...(input.deviceInfo ?? {}),
      ...(input.location === undefined ? {} : { location: { ...input.location } }),
    } satisfies Record<string, unknown> as Prisma.InputJsonValue;

    const userCode = await this.insertWithUniqueUserCode({
      deviceCodeHash: sha256Hex(deviceCode),
      clientKind: input.clientKind,
      hostApp: input.hostApp ?? null,
      deviceInfo,
      ip: input.ip ?? null,
      expiresAt,
    });

    await this.audit.record({
      action: AUTH_AUDIT_ACTIONS.deviceCodeIssued,
      resource: "device_code",
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      data: { clientKind: input.clientKind, hostApp: input.hostApp ?? null },
    });

    const complete = new URL(this.verificationUrl);
    complete.searchParams.set("code", formatUserCode(userCode));

    return {
      deviceCode,
      userCode: formatUserCode(userCode),
      verificationUrl: this.verificationUrl,
      verificationUrlComplete: complete.toString(),
      interval: DEVICE_POLL_INTERVAL_SEC,
      expiresIn: DEVICE_CODE_TTL_SEC,
    };
  }

  /**
   * One poll from the device (RFC 8628 section 3.5).
   *
   * Returns tokens once, when the flow has been approved; every other state is an
   * error the client is expected to handle: `authorization_pending` (keep
   * waiting), `slow_down` (wait longer), `expired_token` (start again),
   * `access_denied` (the user said no).
   */
  async poll(deviceCode: string, context: { ip?: string }): Promise<IssuedTokens> {
    const hash = sha256Hex(deviceCode);
    const record = await this.prisma.deviceCode.findUnique({
      where: { deviceCode: hash },
      select: {
        id: true,
        userCode: true,
        clientKind: true,
        status: true,
        approvedBy: true,
        deviceInfo: true,
        expiresAt: true,
      },
    });
    if (record === null) {
      throw new AppException(
        AUTH_ERRORS.invalidToken,
        "This device code is not valid.",
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.prisma.deviceCode.update({
      where: { id: record.id },
      data: { pollCount: { increment: 1 } },
      select: { id: true },
    });

    if (await this.pollingTooFast(hash)) {
      throw new AppException(
        AUTH_ERRORS.slowDown,
        "Polling too often. Wait longer between requests.",
        HttpStatus.BAD_REQUEST,
        {
          interval: DEVICE_POLL_INTERVAL_SEC + DEVICE_SLOW_DOWN_INCREMENT_SEC,
          minimumInterval: DEVICE_POLL_INTERVAL_SEC,
        },
      );
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      if (record.status === "pending") await this.setStatus(record.id, "expired");
      throw new AppException(
        AUTH_ERRORS.expiredToken,
        "This device code has expired. Start again on the device.",
        HttpStatus.BAD_REQUEST,
      );
    }

    switch (record.status) {
      case "pending":
        throw new AppException(
          AUTH_ERRORS.authorizationPending,
          "Waiting for the code to be approved.",
          HttpStatus.BAD_REQUEST,
          { interval: DEVICE_POLL_INTERVAL_SEC },
        );
      case "denied":
        throw new AppException(
          AUTH_ERRORS.accessDenied,
          "The request was declined.",
          HttpStatus.BAD_REQUEST,
        );
      case "expired":
      case "consumed":
        throw new AppException(
          AUTH_ERRORS.expiredToken,
          "This device code has expired. Start again on the device.",
          HttpStatus.BAD_REQUEST,
        );
      case "approved":
        return this.redeem(record, context);
    }
  }

  /** The approval screen's data, for the signed-in user typing the code. */
  async describe(userCode: string): Promise<PendingApproval> {
    const record = await this.prisma.deviceCode.findUnique({
      where: { userCode },
      select: {
        userCode: true,
        clientKind: true,
        hostApp: true,
        deviceInfo: true,
        ip: true,
        status: true,
        expiresAt: true,
      },
    });
    if (
      record === null ||
      record.status !== "pending" ||
      record.expiresAt.getTime() <= Date.now()
    ) {
      throw new AppException(
        ERROR_CODES.notFound,
        "That code is not waiting for approval.",
        HttpStatus.NOT_FOUND,
      );
    }

    const info = (record.deviceInfo ?? {}) as Record<string, unknown>;
    const location = info["location"];
    return {
      userCode: formatUserCode(record.userCode),
      clientKind: record.clientKind,
      hostApp: record.hostApp,
      deviceInfo: stripLocation(info),
      ip: record.ip,
      location: isLocation(location) ? location : null,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Approve or decline a pending code.
   *
   * `workspaceId` defaults to the workspace the approving session is in, and is
   * always re-checked against `memberships`: approving a device must not be a way
   * to hand it a workspace the approver cannot reach (THREAT-MODEL T4).
   */
  async decide(input: {
    userCode: string;
    approverId: string;
    workspaceId: string;
    approve: boolean;
    ip?: string;
  }): Promise<{ status: "approved" | "denied" }> {
    const record = await this.prisma.deviceCode.findUnique({
      where: { userCode: input.userCode },
      select: { id: true, status: true, expiresAt: true, deviceInfo: true, clientKind: true },
    });
    if (record === null || record.status !== "pending") {
      throw new AppException(
        ERROR_CODES.notFound,
        "That code is not waiting for approval.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      await this.setStatus(record.id, "expired");
      throw new AppException(
        AUTH_ERRORS.expiredToken,
        "That code has expired. Start again on the device.",
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!input.approve) {
      await this.setStatus(record.id, "denied");
      await this.audit.record({
        action: AUTH_AUDIT_ACTIONS.deviceCodeDenied,
        resource: "device_code",
        resourceId: record.id,
        actorId: input.approverId,
        workspaceId: input.workspaceId,
        ...(input.ip === undefined ? {} : { ip: input.ip }),
      });
      return { status: "denied" };
    }

    const membership = await this.users.membership(input.approverId, input.workspaceId);
    if (membership === null || membership.status !== "active") {
      throw new AppException(
        AUTH_ERRORS.notAMember,
        "You are not a member of that workspace.",
        HttpStatus.FORBIDDEN,
      );
    }

    // The workspace the device will get rides in `device_info.approval` because
    // `device_codes` has no workspace column in 06; the tokens are minted from it
    // after the membership check above.
    const info = (record.deviceInfo ?? {}) as Record<string, unknown>;
    await this.prisma.deviceCode.update({
      where: { id: record.id, status: "pending" },
      data: {
        status: "approved",
        approvedBy: input.approverId,
        deviceInfo: {
          ...info,
          approval: { workspaceId: input.workspaceId, at: new Date().toISOString() },
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    await this.audit.record({
      action: AUTH_AUDIT_ACTIONS.deviceCodeApproved,
      resource: "device_code",
      resourceId: record.id,
      actorId: input.approverId,
      workspaceId: input.workspaceId,
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      data: { clientKind: record.clientKind },
    });
    return { status: "approved" };
  }

  /** Mint the device's tokens exactly once, then mark the code consumed. */
  private async redeem(
    record: {
      id: string;
      clientKind: $Enums.ClientKind;
      approvedBy: string | null;
      deviceInfo: Prisma.JsonValue;
    },
    context: { ip?: string },
  ): Promise<IssuedTokens> {
    const approval = (record.deviceInfo ?? {}) as Record<string, unknown>;
    const approvalInfo = approval["approval"];
    const workspaceId =
      typeof approvalInfo === "object" && approvalInfo !== null
        ? (approvalInfo as Record<string, unknown>)["workspaceId"]
        : undefined;

    if (record.approvedBy === null || typeof workspaceId !== "string") {
      throw new AppException(
        ERROR_CODES.conflict,
        "This device code cannot be completed.",
        HttpStatus.CONFLICT,
      );
    }

    // Single-use: only the poll that flips `approved` to `consumed` gets tokens,
    // so two devices holding the same code cannot both be signed in.
    const claimed = await this.prisma.deviceCode.updateMany({
      where: { id: record.id, status: "approved" },
      data: { status: "consumed" },
    });
    if (claimed.count !== 1) {
      throw new AppException(
        AUTH_ERRORS.expiredToken,
        "This device code has already been used.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const membership = await this.users.membership(record.approvedBy, workspaceId);
    if (membership === null || membership.status !== "active") {
      throw new AppException(
        AUTH_ERRORS.notAMember,
        "The approving account is no longer a member of that workspace.",
        HttpStatus.FORBIDDEN,
      );
    }

    const issued = await this.sessions.issue({
      userId: record.approvedBy,
      workspaceId,
      role: membership.role,
      kind: record.clientKind,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
    });

    await this.audit.record({
      action: AUTH_AUDIT_ACTIONS.deviceCodeRedeemed,
      resource: "session",
      resourceId: issued.sessionId,
      actorId: record.approvedBy,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { deviceCodeId: record.id, kind: record.clientKind },
    });
    return issued;
  }

  /** THREAT-MODEL T3: at most five flows in flight from one address. */
  private async assertUnderPendingCap(ip: string): Promise<void> {
    const pending = await this.prisma.deviceCode.count({
      where: { ip, status: "pending", expiresAt: { gt: new Date() } },
    });
    if (pending >= DEVICE_PENDING_CAP_PER_IP) {
      throw new AppException(
        ERROR_CODES.rateLimited,
        "Too many device sign-ins are already waiting. Finish or cancel one first.",
        HttpStatus.TOO_MANY_REQUESTS,
        { pending, limit: DEVICE_PENDING_CAP_PER_IP },
      );
    }
  }

  /**
   * Server-side interval enforcement.
   *
   * `SET key ... NX EX interval` succeeds only when no poll has been seen in the
   * last interval, so the check and the record are one atomic operation. Redis
   * being unavailable means the interval is not enforced, which is the same
   * fail-open trade-off the rate limiter makes.
   */
  private async pollingTooFast(deviceCodeHash: string): Promise<boolean> {
    try {
      const accepted = await this.redis.client.set(
        redisKeys.devicePollAt(deviceCodeHash),
        String(Date.now()),
        "EX",
        DEVICE_POLL_INTERVAL_SEC,
        "NX",
      );
      return accepted === null;
    } catch (error) {
      this.logger.warn({ err: error }, "poll interval not enforced; Redis unavailable");
      return false;
    }
  }

  private async setStatus(id: string, status: $Enums.DeviceCodeStatus): Promise<void> {
    await this.prisma.deviceCode.update({ where: { id }, data: { status }, select: { id: true } });
  }

  /** Insert with a fresh user code, retrying the (very unlikely) collision. */
  private async insertWithUniqueUserCode(data: {
    deviceCodeHash: string;
    clientKind: $Enums.ClientKind;
    hostApp: $Enums.HostApp | null;
    deviceInfo: Prisma.InputJsonValue;
    ip: string | null;
    expiresAt: Date;
  }): Promise<string> {
    for (let attempt = 0; attempt < USER_CODE_ATTEMPTS; attempt += 1) {
      const userCode = generateUserCode();
      try {
        await this.prisma.deviceCode.create({
          data: {
            id: ulid(),
            deviceCode: data.deviceCodeHash,
            userCode,
            clientKind: data.clientKind,
            hostApp: data.hostApp,
            deviceInfo: data.deviceInfo,
            ip: data.ip,
            expiresAt: data.expiresAt,
          },
          select: { id: true },
        });
        return userCode;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        this.logger.warn({ attempt }, "user code collision; regenerating");
      }
    }
    throw new AppException(
      ERROR_CODES.internal,
      "Could not allocate a device code. Try again.",
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

function isLocation(value: unknown): value is CoarseLocation {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The approval screen shows the location separately from the raw device info. */
function stripLocation(info: Record<string, unknown>): Record<string, unknown> {
  const { location: _location, approval: _approval, ...rest } = info;
  return rest;
}
