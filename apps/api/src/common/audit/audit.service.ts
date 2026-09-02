import { Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { PrismaService } from "../prisma/prisma.service.js";

import type { Prisma } from "@prisma/client";

/**
 * The one audit writer for the whole API (B16 addendum, after A05).
 *
 * A04's `AuthAuditService` (`auth/auth-audit.service.ts`) and A05's
 * `AuditService` (`users/audit.service.ts`) started as two copies of the same
 * forty lines, one with a closed `AuthAuditAction` union no module outside
 * `auth` could extend. This is the collapse the orchestrator asked for: one
 * `common/` provider, one open `action: string` union, and both shipped call
 * sites (28 of them across `auth`, `users`, `consents`, `workspaces`, `billing`,
 * ...) left untouched — `AuthAuditService` and `AuditService` now subclass this
 * one and keep their original names, constants and method signatures so nothing
 * that already imports them has to change.
 *
 * It writes the two trails 05 §8 and the DPDP control set (D61) require:
 *
 *   * `audit_log`   — the append-only administrative trail (THREAT-MODEL T20);
 *   * `access_logs` — who touched what, retained at least a year (D61 Rule 6),
 *     purged by B16's `scheduler.access-log-purge` task.
 *
 * A failure is logged at `error` and swallowed: an unavailable audit table must
 * not become a way to deny a member their own profile or a login. X01
 * re-verifies that trade-off before Gate C, exactly as the two predecessors
 * documented it.
 */
export interface CommonAuditEvent {
  /** `<domain>.<noun>.<verb>`, past tense — open, so every module can add its own. */
  readonly action: string;
  /** The kind of thing acted on: `user`, `workspace`, `session`, ... */
  readonly resource: string;
  readonly resourceId?: string;
  readonly actorId?: string;
  readonly actorKind?: string;
  readonly workspaceId?: string;
  readonly ip?: string;
  /** Before/after for the changed fields only. Never a credential or a token. */
  readonly data?: Prisma.InputJsonValue;
}

@Injectable()
export class CommonAuditService {
  private readonly logger = new Logger(CommonAuditService.name);

  constructor(protected readonly prisma: PrismaService) {}

  async record(event: CommonAuditEvent): Promise<void> {
    const at = new Date();
    try {
      await this.prisma.$transaction([
        this.prisma.auditLog.create({
          data: {
            id: ulid(),
            action: event.action,
            resource: event.resource,
            resourceId: event.resourceId ?? null,
            actorId: event.actorId ?? null,
            actorKind: event.actorKind ?? "user",
            workspaceId: event.workspaceId ?? null,
            data: event.data ?? undefined,
            ip: event.ip ?? null,
            at,
          },
        }),
        this.prisma.accessLog.create({
          data: {
            id: ulid(),
            actorId: event.actorId ?? null,
            workspaceId: event.workspaceId ?? null,
            resource: event.resource,
            action: event.action,
            ip: event.ip ?? null,
            at,
          },
        }),
      ]);
    } catch (error) {
      this.logger.error({ err: error, action: event.action }, "could not write the audit trail");
    }
  }

  /**
   * `access_logs` only — no `audit_log` row. For a **read** of personal data
   * (`AccessLogInterceptor`), not a mutation: `audit_log` (THREAT-MODEL T20)
   * is the administrative trail of things that changed, and a `GET` changes
   * nothing. Retained at least a year (D61 Rule 6), purged by
   * `scheduler.access-log-purge`.
   */
  async recordAccess(event: Omit<CommonAuditEvent, "actorKind">): Promise<void> {
    try {
      await this.prisma.accessLog.create({
        data: {
          id: ulid(),
          actorId: event.actorId ?? null,
          workspaceId: event.workspaceId ?? null,
          resource: event.resource,
          action: event.action,
          ip: event.ip ?? null,
          at: new Date(),
        },
      });
    } catch (error) {
      this.logger.error({ err: error, action: event.action }, "could not write the access log");
    }
  }
}
