import { Injectable, Logger } from "@nestjs/common";

import { WebhookDeliveryService } from "./webhook-delivery.service.js";
import { WEBHOOK_POLL_BATCH } from "./webhooks.constants.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { redisKeyPrefix } from "../common/redis/redis-keys.js";
import { RedisService } from "../common/redis/redis.service.js";

/** Kind names understood by `NOTIFY_KINDS`; only `"low-credits"` matters here. */
const LOW_CREDITS_NOTIFY_KIND = "low-credits";

/**
 * The `transcript.completed` / `job.failed` / `credits.low` half of B14 §4.
 *
 * `export.completed` already has a real signal to listen to
 * (`listeners/export-completed.listener.ts`, `EventEmitter2`). The other three
 * do not: nothing in `transcripts/`, `jobs/` or `credits/` emits an event for
 * them today, and adding one means editing files outside this WP's boundary
 * (`apps/api/src/{transcripts,jobs,credits}/**`, none of them listed) the way
 * `referrals/export-completed.event.ts` documents doing for exports.
 *
 * Rather than take that same edit three more times across modules two other
 * work packages (B11, B18) are actively changing in parallel — real risk of a
 * merge collision for a one-line `events.emit` — this polls the rows those
 * modules already write, which is uncontroversially read-only from here:
 *
 *   - `transcript.completed`: `jobs` rows with `type = "ai.transcribe"` and
 *     `status = "succeeded"`, in id order (ULIDs sort by creation time).
 *   - `job.failed`: `jobs` rows with `status = "failed"`, any type.
 *   - `credits.low`: `notifications` rows with `kind = "low-credits"`
 *     (`credits/credits-low-balance.notifier.ts` already writes one there via
 *     `NotifyService.enqueue` every time the 20%/0% threshold fires — this
 *     reads that row rather than reimplementing the threshold logic).
 *
 * Each stream keeps its own "last id seen" cursor in Redis so a tick only reads
 * what is new. At most {@link WEBHOOK_POLL_BATCH} rows per stream per tick, so
 * one pathological backlog cannot hold the loop open — the next tick picks up
 * where this one left off.
 *
 * **Reported as a deviation** (same shape `referrals/export-completed.event.ts`
 * already flags for exports): the brief describes emitting these three events
 * from their producers directly; this WP does it by polling instead, to stay
 * inside its file boundaries. A later WP that owns `transcripts/`, `jobs/` or
 * `credits/` can replace a stream with a real `EventEmitter2` emit without
 * this service's public shape changing — `dispatchDue`/`emit` stay the same
 * either way.
 */
@Injectable()
export class WebhookEventPollerService {
  private readonly logger = new Logger(WebhookEventPollerService.name);
  private readonly prefix = redisKeyPrefix();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly delivery: WebhookDeliveryService,
  ) {}

  async pollTranscriptsCompleted(): Promise<{ readonly seen: number }> {
    return this.pollJobs("ai.transcribe", "succeeded", "transcript.completed", (job) => ({
      transcriptJobId: job.id,
      projectId: job.projectId,
    }));
  }

  async pollJobsFailed(): Promise<{ readonly seen: number }> {
    return this.pollJobs(undefined, "failed", "job.failed", (job) => ({
      jobId: job.id,
      jobType: job.type,
      projectId: job.projectId,
      error: (job.error as { message?: string } | null)?.message ?? null,
    }));
  }

  async pollCreditsLow(): Promise<{ readonly seen: number }> {
    const cursorKey = this.cursorKey("credits-low");
    const cursor = await this.readCursor(cursorKey);

    // Cold start: prime the cursor at "now" rather than replaying every
    // low-balance notification the workspace has ever received.
    if (cursor === undefined) {
      await this.primeCursor(cursorKey, () =>
        this.prisma.notification.findFirst({
          where: { kind: LOW_CREDITS_NOTIFY_KIND },
          orderBy: { id: "desc" },
          select: { id: true },
        }),
      );
      return { seen: 0 };
    }

    const rows = await this.prisma.notification.findMany({
      where: {
        kind: LOW_CREDITS_NOTIFY_KIND,
        workspaceId: { not: null },
        ...(cursor === undefined ? {} : { id: { gt: cursor } }),
      },
      orderBy: { id: "asc" },
      take: WEBHOOK_POLL_BATCH,
    });

    for (const row of rows) {
      if (row.workspaceId === null) continue;
      await this.delivery.emit({
        workspaceId: row.workspaceId,
        event: "credits.low",
        data: (row.data as Record<string, unknown>) ?? {},
      });
    }
    if (rows.length > 0) await this.writeCursor(cursorKey, rows[rows.length - 1]?.id ?? cursor);
    return { seen: rows.length };
  }

  private async pollJobs(
    type: string | undefined,
    status: "succeeded" | "failed",
    event: "transcript.completed" | "job.failed",
    data: (job: {
      readonly id: string;
      readonly type: string;
      readonly projectId: string | null;
      readonly error: unknown;
    }) => Record<string, unknown>,
  ): Promise<{ readonly seen: number }> {
    const cursorKey = this.cursorKey(event);
    const cursor = await this.readCursor(cursorKey);

    if (cursor === undefined) {
      await this.primeCursor(cursorKey, () =>
        this.prisma.job.findFirst({
          where: { status, ...(type === undefined ? {} : { type }) },
          orderBy: { id: "desc" },
          select: { id: true },
        }),
      );
      return { seen: 0 };
    }

    const rows = await this.prisma.job.findMany({
      where: { status, ...(type === undefined ? {} : { type }), id: { gt: cursor } },
      orderBy: { id: "asc" },
      take: WEBHOOK_POLL_BATCH,
    });

    for (const row of rows) {
      await this.delivery.emit({ workspaceId: row.workspaceId, event, data: data(row) });
    }
    if (rows.length > 0) await this.writeCursor(cursorKey, rows[rows.length - 1]?.id ?? cursor);
    return { seen: rows.length };
  }

  private cursorKey(stream: string): string {
    return `${this.prefix}:webhooks:cursor:${stream}`;
  }

  private async readCursor(key: string): Promise<string | undefined> {
    try {
      const value = await this.redis.client.get(key);
      return value ?? undefined;
    } catch (error) {
      this.logger.warn(
        { err: error, key },
        "could not read a webhook poll cursor; scanning from the start",
      );
      return undefined;
    }
  }

  private async primeCursor(
    key: string,
    latest: () => Promise<{ readonly id: string } | null>,
  ): Promise<void> {
    const row = await latest();
    // No matching row yet at all: write a sentinel so the next tick does not
    // re-run this same "find the latest" query forever.
    await this.writeCursor(key, row?.id ?? "0");
  }

  private async writeCursor(key: string, value: string | undefined): Promise<void> {
    if (value === undefined) return;
    try {
      await this.redis.client.set(key, value);
    } catch (error) {
      this.logger.warn({ err: error, key }, "could not persist a webhook poll cursor");
    }
  }
}
