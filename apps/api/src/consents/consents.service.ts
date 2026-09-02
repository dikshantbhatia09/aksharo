import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ulid } from "ulid";

import { CONSENT_PURPOSES } from "./consents.dto.js";
import { PrismaService } from "../common/index.js";
import { CONSENT_EVENTS } from "../memory/consent-events.js";
import { A05_AUDIT_ACTIONS, AuditService } from "../users/audit.service.js";
import { PRIVACY_NOTICE_VERSION } from "../users/users.service.js";

import type { RequestContextInfo } from "../users/profile.service.js";
import type { $Enums, Prisma } from "@prisma/client";

export interface ConsentState {
  readonly purpose: $Enums.ConsentPurpose;
  readonly granted: boolean;
  readonly version: string | null;
  readonly decidedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly recorded: boolean;
}

export interface ConsentsView {
  readonly noticeVersion: string;
  readonly reconsentRequired: boolean;
  readonly purposes: readonly ConsentState[];
}

/**
 * Per-purpose consent (D61, D62).
 *
 * `consent_records` is **append-only**: granting, withdrawing and re-granting all
 * write a new row, and the current answer is the newest row for the purpose. The
 * notice-and-choice record the DPDP rules require is the *history*, not a boolean,
 * so nothing here ever updates a row's `granted` in place.
 *
 * Withdrawal additionally stamps `withdrawnAt` on the rows that were granting the
 * purpose, so "when did this stop applying" is answerable without replaying the
 * whole log — which is what a retention job or an audit will ask.
 *
 * Three purposes are mirrored onto `users` because the columns exist in 06 and
 * other modules read them on the hot path: `marketingOptIn`, `analyticsConsentAt`
 * and `memoryConsentAt`. The rows remain the source of truth.
 */
@Injectable()
export class ConsentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  /** The current answer for every purpose the notice asks about. */
  async current(userId: string): Promise<ConsentsView> {
    const rows = await this.prisma.consentRecord.findMany({
      where: { userId },
      orderBy: { grantedAt: "desc" },
      select: { purpose: true, granted: true, version: true, grantedAt: true, withdrawnAt: true },
    });

    const latest = new Map<$Enums.ConsentPurpose, (typeof rows)[number]>();
    for (const row of rows) if (!latest.has(row.purpose)) latest.set(row.purpose, row);

    const purposes = CONSENT_PURPOSES.map<ConsentState>((purpose) => {
      const row = latest.get(purpose);
      if (row === undefined) {
        return {
          purpose,
          granted: false,
          version: null,
          decidedAt: null,
          withdrawnAt: null,
          recorded: false,
        };
      }
      return {
        purpose,
        granted: row.granted && row.withdrawnAt === null,
        version: row.version,
        decidedAt: row.grantedAt.toISOString(),
        withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
        recorded: true,
      };
    });

    // A purpose answered against an older notice has to be asked again: that is
    // what "notice and choice" means when the notice changes (D61, Rule 3).
    const reconsentRequired = purposes.some(
      (state) => state.recorded && state.version !== PRIVACY_NOTICE_VERSION,
    );

    return { noticeVersion: PRIVACY_NOTICE_VERSION, reconsentRequired, purposes };
  }

  /** Record a grant or a withdrawal, and mirror it onto the user row. */
  async set(
    userId: string,
    workspaceId: string,
    purpose: $Enums.ConsentPurpose,
    granted: boolean,
    context: RequestContextInfo,
  ): Promise<ConsentsView> {
    const now = new Date();

    await this.prisma.withTransaction(async (tx) => {
      await tx.consentRecord.create({
        data: {
          id: ulid(),
          userId,
          workspaceId,
          purpose,
          version: PRIVACY_NOTICE_VERSION,
          noticeVersion: PRIVACY_NOTICE_VERSION,
          granted,
          grantedAt: now,
          withdrawnAt: granted ? null : now,
          ip: context.ip ?? null,
          ua: context.ua ?? null,
        },
      });

      if (!granted) {
        // Close every still-open grant of this purpose, so the retention job and
        // any later audit can see when it stopped applying.
        await tx.consentRecord.updateMany({
          where: { userId, purpose, granted: true, withdrawnAt: null },
          data: { withdrawnAt: now },
        });
      }

      const mirror = mirrorOntoUser(purpose, granted, now);
      if (mirror !== null) await tx.user.update({ where: { id: userId }, data: mirror });
    });

    await this.audit.record({
      action: A05_AUDIT_ACTIONS.consentRecorded,
      resource: "consent_record",
      actorId: userId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { purpose, granted, noticeVersion: PRIVACY_NOTICE_VERSION },
    });

    // B09 (D62): a memory withdrawal erases `memory_entries`, not just the grant.
    if (!granted) this.events.emit(CONSENT_EVENTS.withdrawn, { userId, workspaceId, purpose });

    return this.current(userId);
  }
}

/**
 * The `users` columns 06 keeps beside the records, or `null` for a purpose that
 * has none. Denormalised for the hot path; the rows stay authoritative.
 */
export function mirrorOntoUser(
  purpose: $Enums.ConsentPurpose,
  granted: boolean,
  at: Date,
): Prisma.UserUpdateInput | null {
  switch (purpose) {
    case "marketing":
      return { marketingOptIn: granted };
    case "analytics":
      return { analyticsConsentAt: granted ? at : null };
    case "memory":
      return { memoryConsentAt: granted ? at : null };
    default:
      return null;
  }
}
