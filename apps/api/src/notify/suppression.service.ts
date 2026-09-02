import { createHash } from "node:crypto";

import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { ulid } from "ulid";

import { NOTIFY_AUDIT_ACTIONS, SUPPRESSION_TTL_SEC, notifyRedisKeys } from "./notify.constants.js";
import { maskEmail, PrismaService, RedisService } from "../common/index.js";

import type { SuppressionPermanence } from "./sns/ses-event.js";
import type { $Enums, Prisma } from "@prisma/client";

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
  /** The SES/SNS message id, for `mail_suppressions.source_event_id`, when known. */
  readonly sourceEventId?: string;
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
 *
 * **A third store, added B16 (addendum after A25): `mail_suppressions`.** Redis
 * is fast but disposable — a flushed cache, a fresh replica, a Redis migration —
 * and `audit_log` is a trail, not something this service reads back. Neither is
 * "the list a flushed Redis rebuilds itself from", so a durable row is written
 * (or deleted, on `releaseTransient`) alongside every Redis write, and
 * {@link onApplicationBootstrap} replays every still-live row into Redis before
 * the API starts taking traffic — a cold Redis must come up already refusing to
 * mail a hard bounce, not permissively for however long it takes the next bounce
 * to arrive. Admin read/clear of this table is B13's.
 */
@Injectable()
export class SuppressionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SuppressionService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  /** Replay every durable, still-live entry into Redis before the app serves traffic. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const rows = await this.prisma.mailSuppression.findMany({
        where: { OR: [{ until: null }, { until: { gt: new Date() } }] },
        select: { addressHash: true, reason: true, until: true, createdAt: true },
      });
      let restored = 0;
      for (const row of rows) {
        const entry: SuppressionEntry = {
          permanence: row.reason === "transient" ? "transient" : "permanent",
          reason: row.reason,
          at: row.createdAt.toISOString(),
        };
        const key = notifyRedisKeys.suppression(row.addressHash);
        const ttlSec =
          row.until === null ? undefined : Math.max(1, secondsUntil(row.until, new Date()));
        if (ttlSec === undefined) await this.redis.client.set(key, JSON.stringify(entry));
        else await this.redis.client.set(key, JSON.stringify(entry), "EX", ttlSec);
        restored += 1;
      }
      if (restored > 0) {
        this.logger.log({ restored }, "mail suppression list rebuilt from mail_suppressions");
      }
    } catch (error) {
      // A cold boot that cannot reach Postgres has bigger problems than an empty
      // suppression cache; do not block startup on it.
      this.logger.error({ err: error }, "could not rebuild the suppression list at boot");
    }
  }

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

    await this.persist(input, entry);
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
    const hash = SuppressionService.hash(email);
    try {
      await this.redis.client.del(notifyRedisKeys.suppression(hash));
    } catch (error) {
      this.logger.warn({ err: error }, "could not release a suppression entry");
      return false;
    }
    try {
      await this.prisma.mailSuppression.deleteMany({ where: { addressHash: hash } });
    } catch (error) {
      this.logger.warn({ err: error }, "could not clear the durable suppression row");
    }
    this.logger.log({ to: maskEmail(email) }, "transient suppression released after a delivery");
    return true;
  }

  /** Upsert the durable row {@link onApplicationBootstrap} rebuilds Redis from. */
  private async persist(input: SuppressInput, entry: SuppressionEntry): Promise<void> {
    const hash = SuppressionService.hash(input.email);
    const reason = mailSuppressionReason(input);
    const until =
      entry.permanence === "transient"
        ? new Date(Date.now() + (SUPPRESSION_TTL_SEC.transient ?? 0) * 1000)
        : null;
    try {
      await this.prisma.mailSuppression.upsert({
        where: { addressHash: hash },
        create: {
          id: ulid(),
          addressHash: hash,
          reason,
          until,
          sourceEventId: input.sourceEventId ?? null,
        },
        update: { reason, until, sourceEventId: input.sourceEventId ?? null },
      });
    } catch (error) {
      this.logger.error({ err: error }, "could not write the durable suppression row");
    }
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

/** Coarse `MailSuppressionReason` from a `SuppressInput`, by permanence then source. */
function mailSuppressionReason(input: SuppressInput): $Enums.MailSuppressionReason {
  if (input.permanence === "transient") return "transient";
  return input.source === "ses-complaint" ? "complaint" : "hard_bounce";
}

function secondsUntil(target: Date, from: Date): number {
  return Math.ceil((target.getTime() - from.getTime()) / 1000);
}
