import { Injectable } from "@nestjs/common";

import { CommonAuditService } from "../common/audit/audit.service.js";
import { PrismaService } from "../common/index.js";

import type { Prisma } from "@prisma/client";

/**
 * Every mutation A05 owns, as one string per event so a query is a `grep`.
 *
 * The naming follows A04's `AUTH_AUDIT_ACTIONS`: `<domain>.<noun>.<verb>`, past
 * tense, never a sentence.
 */
export const A05_AUDIT_ACTIONS = {
  profileUpdated: "user.profile.updated",
  dataExportRequested: "user.data_export.requested",
  dataExportDownloaded: "user.data_export.downloaded",
  erasureRequested: "user.erasure.requested",

  consentRecorded: "consent.recorded",

  workspaceCreated: "workspace.created",
  workspaceUpdated: "workspace.updated",
  workspaceDeleted: "workspace.deleted",
  taxProfileUpdated: "workspace.tax_profile.updated",

  memberInvited: "workspace.member.invited",
  memberInviteAccepted: "workspace.member.invite_accepted",
  memberInviteDeclined: "workspace.member.invite_declined",
  memberRoleChanged: "workspace.member.role_changed",
  memberRemoved: "workspace.member.removed",

  parentalWaitlistImported: "parental_waitlist.imported",
} as const;

export type A05AuditAction = (typeof A05_AUDIT_ACTIONS)[keyof typeof A05_AUDIT_ACTIONS];

export interface AuditEvent {
  readonly action: string;
  /** The kind of thing acted on: `user`, `workspace`, `membership`, ... */
  readonly resource: string;
  readonly resourceId?: string;
  readonly actorId?: string;
  readonly workspaceId?: string;
  readonly ip?: string;
  /** Before/after for the changed fields only. Never a credential or a token. */
  readonly data?: Prisma.InputJsonValue;
}

/**
 * The two trails 05 §8 and the DPDP control set (D61) require, for every module
 * that is not `auth`:
 *
 *   * `audit_log`   — the append-only administrative trail (THREAT-MODEL T20);
 *   * `access_logs` — who touched what, retained at least a year (D61 Rule 6).
 *
 * This is deliberately the same shape as A04's `AuthAuditService`, minus that
 * service's closed `AuthAuditAction` union, which no module outside `auth` can
 * extend. Collapsing the two into one `common/` provider is a tidy-up for a work
 * package that owns `common/`; duplicating forty lines here beats widening a
 * shipped module's public type from outside it.
 *
 * A failure is logged at `error` and swallowed: an unavailable audit table must
 * not become a way to deny a member their own profile. X01 re-verifies that
 * trade-off before Gate C, exactly as it does for `auth`.
 *
 * **Implementation note (B16 addendum, after A05):** the actual write lives in
 * `common/audit/audit.service.ts` (`CommonAuditService`), collapsed together
 * with `auth/auth-audit.service.ts`'s `AuthAuditService` into one writer with an
 * open action union. This class subclasses it and keeps its original name and
 * `record(event: AuditEvent)` signature so the 21 existing call sites in this
 * module tree, and their tests, do not change.
 */
@Injectable()
export class AuditService extends CommonAuditService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  override record(event: AuditEvent): Promise<void> {
    return super.record(event);
  }
}
