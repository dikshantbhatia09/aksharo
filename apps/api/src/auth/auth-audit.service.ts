import { Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { PrismaService } from "../common/index.js";

import type { Prisma } from "@prisma/client";

/** The security events A04 records. One string per event, so queries are greppable. */
export const AUTH_AUDIT_ACTIONS = {
  signupStarted: "auth.signup.started",
  emailVerified: "auth.email.verified",
  login: "auth.login",
  loginFailed: "auth.login.failed",
  magicLinkRequested: "auth.magic_link.requested",
  magicLinkConsumed: "auth.magic_link.consumed",
  oauthLinked: "auth.oauth.linked",
  logout: "auth.logout",
  tokenRefreshed: "auth.token.refreshed",
  refreshReuseDetected: "auth.refresh.reuse_detected",
  tokenExchanged: "auth.token.exchanged",
  sessionRevoked: "auth.session.revoked",
  deviceCodeIssued: "auth.device_code.issued",
  deviceCodeApproved: "auth.device_code.approved",
  deviceCodeDenied: "auth.device_code.denied",
  deviceCodeRedeemed: "auth.device_code.redeemed",
  ageRestricted: "auth.age_restricted",
  parentalWaitlistJoined: "auth.parental_waitlist.joined",
} as const;

export type AuthAuditAction = (typeof AUTH_AUDIT_ACTIONS)[keyof typeof AUTH_AUDIT_ACTIONS];

export interface AuditEntry {
  readonly action: AuthAuditAction;
  /** The kind of thing acted on: `session`, `user`, `device_code`, ... */
  readonly resource: string;
  readonly resourceId?: string;
  readonly actorId?: string;
  readonly workspaceId?: string;
  readonly ip?: string;
  /** Never credentials, tokens or hashes — only ids, reasons and counts. */
  readonly data?: Prisma.InputJsonValue;
}

/**
 * Writes the two trails 05 §8 and the DPDP control set require:
 *
 *   * `audit_log`   — the append-only administrative trail (THREAT-MODEL T20).
 *   * `access_logs` — who touched what, retained at least a year (05 §8, D70).
 *
 * A failure here is logged at `error` and swallowed: an unavailable audit table
 * must not be a way to deny logins, and the request-scoped pino line still carries
 * the event. X01 re-verifies this trade-off before Gate C.
 */
@Injectable()
export class AuthAuditService {
  private readonly logger = new Logger(AuthAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    const at = new Date();
    try {
      await this.prisma.$transaction([
        this.prisma.auditLog.create({
          data: {
            id: ulid(),
            action: entry.action,
            resource: entry.resource,
            resourceId: entry.resourceId ?? null,
            actorId: entry.actorId ?? null,
            actorKind: "user",
            workspaceId: entry.workspaceId ?? null,
            data: entry.data ?? undefined,
            ip: entry.ip ?? null,
            at,
          },
        }),
        this.prisma.accessLog.create({
          data: {
            id: ulid(),
            actorId: entry.actorId ?? null,
            workspaceId: entry.workspaceId ?? null,
            resource: entry.resource,
            action: entry.action,
            ip: entry.ip ?? null,
            at,
          },
        }),
      ]);
    } catch (error) {
      this.logger.error({ err: error, action: entry.action }, "could not write the audit trail");
    }
  }
}
