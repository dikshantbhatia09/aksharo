import { Injectable } from "@nestjs/common";

import { CommonAuditService } from "../common/audit/audit.service.js";
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
 *
 * **Implementation note (B16 addendum, after A05):** the actual write lives in
 * `common/audit/audit.service.ts` (`CommonAuditService`), collapsed together
 * with `users/audit.service.ts`'s `AuditService` into one writer with an open
 * action union. This class subclasses it and keeps its original name,
 * `AUTH_AUDIT_ACTIONS` and `record(entry: AuditEntry)` signature so the 7
 * existing call sites in `auth/` and their tests do not change.
 */
@Injectable()
export class AuthAuditService extends CommonAuditService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  override record(entry: AuditEntry): Promise<void> {
    return super.record(entry);
  }
}
