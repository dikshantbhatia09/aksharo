import { Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { parentalWaitlistRow } from "./parental-waitlist.js";
import { redisKeys } from "../auth/auth.constants.js";
import { PrismaService, RedisService } from "../common/index.js";
import { A05_AUDIT_ACTIONS, AuditService } from "../users/audit.service.js";

import type { WaitlistEntryInput } from "./parental-waitlist.js";
import type { OnModuleInit } from "@nestjs/common";
import type { $Enums } from "@prisma/client";

export interface WaitlistEntry {
  readonly id: string;
  readonly emailHash: string;
  readonly jurisdiction: $Enums.Jurisdiction;
  readonly ageBracket: $Enums.AgeBracket;
  readonly createdAt: string;
  readonly notifiedAt: string | null;
}

export interface WaitlistPage {
  readonly items: readonly WaitlistEntry[];
  readonly nextCursor: string | null;
  readonly total: number;
}

/** What one Redis hash field held before this table existed (A04). */
interface LegacyEntry {
  email?: string;
  at?: string;
}

const MAX_PAGE_SIZE = 200;

/**
 * The parental-consent waiting list (D60), and the one-off migration of A04's
 * Redis entries into it.
 *
 * A04 had nowhere durable to put these: `06-data-model.md` has no table and the
 * Prisma schema was frozen outside A03, so the entries went into the Redis hash
 * `montaj:auth:parental-waitlist` keyed by `sha256(email)`. That hash has no TTL,
 * which makes it a personal-data store with no retention policy on an instance
 * that can be flushed — the worst of both. The table replaces it.
 *
 * Only the hash of the address is ever stored. The list's job is to answer "how
 * many people are waiting, and in which jurisdictions" and, once the
 * parental-consent flow ships (before May 2027), to let the mailer match an
 * address a person types back to a row. Keeping the plaintext address of a
 * declared minor for two years, to send one message, is not a trade worth making.
 */
@Injectable()
export class ParentalWaitlistService implements OnModuleInit {
  private readonly logger = new Logger(ParentalWaitlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Drain A04's Redis hash into the table at boot.
   *
   * Idempotent (the unique index on `email_hash` absorbs a repeat) and best
   * effort: an unreachable Redis or an unmigrated database must not stop the API
   * from booting, and the next boot tries again. The hash is deleted only after
   * every field has been written, so a crash halfway through loses nothing.
   */
  async onModuleInit(): Promise<void> {
    try {
      const migrated = await this.migrateFromRedis();
      if (migrated > 0) {
        this.logger.log({ migrated }, "parental waitlist migrated out of Redis");
        await this.audit.record({
          action: A05_AUDIT_ACTIONS.parentalWaitlistImported,
          resource: "parental_waitlist",
          data: { migrated },
        });
      }
    } catch (error) {
      this.logger.warn({ err: error }, "could not migrate the parental waitlist out of Redis");
    }
  }

  /** @returns how many entries were written. */
  async migrateFromRedis(): Promise<number> {
    const key = redisKeys.parentalWaitlist();
    const hash = await this.redis.client.hgetall(key);
    const fields = Object.entries(hash);
    if (fields.length === 0) return 0;

    let written = 0;
    for (const [emailHash, raw] of fields) {
      if (!/^[0-9a-f]{64}$/.test(emailHash)) {
        this.logger.warn({ emailHash: emailHash.slice(0, 8) }, "skipping a malformed waitlist key");
        continue;
      }
      const legacy = parseLegacy(raw);
      const created = await this.prisma.parentalWaitlist.createMany({
        data: {
          id: ulid(),
          emailHash,
          // A04 recorded neither, and the row must not invent them. `OTHER` and
          // `minor` are the schema defaults and are what the entry means: somebody
          // the age gate turned away, jurisdiction unrecorded.
          jurisdiction: "OTHER",
          ageBracket: "minor",
          ...(legacy.at === undefined ? {} : { createdAt: new Date(legacy.at) }),
        },
        skipDuplicates: true,
      });
      written += created.count;
    }

    await this.redis.client.del(key);
    return written;
  }

  /**
   * Record an entry. Idempotent on the address, so a resubmission neither
   * duplicates the row nor resets its `createdAt`.
   */
  async join(input: WaitlistEntryInput): Promise<void> {
    await this.prisma.parentalWaitlist.createMany({
      data: parentalWaitlistRow(input),
      skipDuplicates: true,
    });
  }

  /** Oldest first: the list is worked through in the order people joined it. */
  async list(options: { cursor?: string; limit?: number } = {}): Promise<WaitlistPage> {
    const take = Math.min(Math.max(options.limit ?? 50, 1), MAX_PAGE_SIZE);
    const [rows, total] = await Promise.all([
      this.prisma.parentalWaitlist.findMany({
        orderBy: { id: "asc" },
        take: take + 1,
        ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
        select: {
          id: true,
          emailHash: true,
          jurisdiction: true,
          ageBracket: true,
          createdAt: true,
          notifiedAt: true,
        },
      }),
      this.prisma.parentalWaitlist.count(),
    ]);

    const page = rows.slice(0, take);
    return {
      items: page.map((row) => ({
        id: row.id,
        emailHash: row.emailHash,
        jurisdiction: row.jurisdiction,
        ageBracket: row.ageBracket,
        createdAt: row.createdAt.toISOString(),
        notifiedAt: row.notifiedAt?.toISOString() ?? null,
      })),
      nextCursor: rows.length > take ? (page.at(-1)?.id ?? null) : null,
      total,
    };
  }
}

function parseLegacy(raw: string): LegacyEntry {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const at = (parsed as LegacyEntry).at;
    return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? { at } : {};
  } catch {
    return {};
  }
}
