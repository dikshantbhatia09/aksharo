import { createHash } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { NOTIFY_AUDIT_ACTIONS, SUPPRESSION_TTL_SEC, notifyRedisKeys } from "./notify.constants.js";
import { maskEmail, PrismaService, RedisService } from "../common/index.js";

import type { SuppressionPermanence } from "./sns/ses-event.js";
import type { Prisma } from "@prisma/client";

export interface SuppressionEntry {
  readonly permanence: SuppressionPermanence;
  /** `Permanent/General`, `abuse`, ... — from the SES event. */
  readonly reason: string;
  readonly at: string;
}

export interface SuppressInput {
  readonly email: string;
  readonly permanence: SuppressionPermanence;
  readonly reason: string;
  /** Where the fact came from, for the audit row: `ses-bounce`, `ses-complaint`. */
  readonly source: string;
}

/**
 * The list of addresses that must not be written to again, and the durable trail
 * of how each one got there.
 *
 * **Two stores, on purpose.** Redis holds the live set, because the check runs on
 * the hot path of every send and a permanent entry has no TTL; `audit_log` holds
 * the history, because "why did we stop mailing this customer?" is a question
 * asked months later and a cache is not an answer to it. If Redis were wiped, the
 * audit rows are what a rebuild would be reconstructed from.
 *
 * Addresses are keyed by SHA-256. A Redis instance is dumped, snapshotted and
 * read over a console far more casually than a database is, and a set of plain
 * addresses is a mailing list; the hash is enough to answer "is this one on it?"
 * and useless for anything else. The audit row carries the masked address
 * (`a***@example.com`), which is what `redactLogObject` would have written anyway
 * (05 section 8).
 */
@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  /** Stable, lower-cased, so `A@B.com` and `a@b.com` share one entry. */
  static hash(email: string): string {
    return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
  }

  /**
   * The entry for an address, or `null`.
   *
   * **Fails open**, like the rate limiter: a Redis outage must not stop a
   * password-reset link from going out. The consequence — a message to an address
   * that bounced — is recoverable; a locked-out user is not.
   */
  async lookup(email: string): Promise<SuppressionEntry | null> {
    try {
      const raw = await this.redis.client.get(
        notifyRedisKeys.suppression(SuppressionService.hash(email)),
      );
      return raw === null ? null : (JSON.parse(raw) as SuppressionEntry);
    } catch (error) {
      this.logger.warn({ err: error }, "suppression list unavailable; allowing the send");
      return null;
    }
  }

  async isSuppressed(email: string): Promise<boolean> {
    return (await this.lookup(email)) !== null;
  }

  /** Add an address, and write the audit row that outlives Redis. */
  async suppress(input: SuppressInput): Promise<void> {
    const entry: SuppressionEntry = {
      permanence: input.permanence,
      reason: input.reason,
      at: new Date().toISOString(),
    };
    const key = notifyRedisKeys.suppression(SuppressionService.hash(input.email));
    const ttl = SUPPRESSION_TTL_SEC[input.permanence];

    try {
      if (ttl === undefined) await this.redis.client.set(key, JSON.stringify(entry));
      else await this.redis.client.set(key, JSON.stringify(entry), "EX", ttl);
    } catch (error) {
      this.logger.error({ err: error }, "could not write the suppression entry");
    }

    await this.audit(NOTIFY_AUDIT_ACTIONS.suppressed, input.email, {
      permanence: input.permanence,
      reason: input.reason,
      source: input.source,
    });
    this.logger.log(
      { to: maskEmail(input.email), permanence: input.permanence, reason: input.reason },
      "address suppressed",
    );
  }

  /**
   * Lift a suppression.
   *
   * Called on a `Delivery` event, which is proof the mailbox works again, and
   * only for a transient entry: a permanent bounce or a complaint is never
   * released by a later delivery, because a complaint is a decision the recipient
   * made and not a fact about the mailbox.
   */
  async releaseTransient(email: string): Promise<boolean> {
    const entry = await this.lookup(email);
    if (entry === null || entry.permanence !== "transient") return false;
    try {
      await this.redis.client.del(notifyRedisKeys.suppression(SuppressionService.hash(email)));
    } catch (error) {
      this.logger.warn({ err: error }, "could not release a suppression entry");
      return false;
    }
    this.logger.log({ to: maskEmail(email) }, "transient suppression released after a delivery");
    return true;
  }

  /** The audit row for a message that was not sent because the address is on the list. */
  async recordSkip(email: string, kind: string, entry: SuppressionEntry): Promise<void> {
    await this.audit(NOTIFY_AUDIT_ACTIONS.skipped, email, {
      kind,
      permanence: entry.permanence,
      reason: entry.reason,
      suppressedAt: entry.at,
    });
  }

  private async audit(action: string, email: string, data: Record<string, string>): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          id: ulid(),
          action,
          resource: "email",
          // `audit_log.resource_id` is a CHAR(26) for ULIDs, so the address goes
          // in `data` — masked, because an audit table is not a mailing list
          // either.
          resourceId: null,
          actorId: null,
          actorKind: "system",
          workspaceId: null,
          data: { ...data, email: maskEmail(email) } satisfies Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // Same trade-off as `AuthAuditService`: an unavailable audit table must not
      // become a way to keep mailing an address that complained.
      this.logger.error({ err: error, action }, "could not write the suppression audit row");
    }
  }
}
