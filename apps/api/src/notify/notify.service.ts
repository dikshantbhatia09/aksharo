import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import {
  NOTIFICATIONS_MAX_PAGE_SIZE,
  NOTIFICATIONS_PAGE_SIZE,
  NOTIFY_ERRORS,
  NOTIFY_JOB_NAME,
  NOTIFY_PRIORITY,
  NO_WORKSPACE,
} from "./notify.constants.js";
import { isCriticalKind, isInAppKind, isNotifyKind } from "./notify.kinds.js";
import { AppException, ERROR_CODES, maskEmail, PrismaService } from "../common/index.js";
import { buildJobEnvelope } from "../jobs/contracts/job-envelope.js";
import { retryPolicyFor } from "../jobs/jobs.config.js";
import { QueueRegistry } from "../jobs/queue.registry.js";
import { RealtimePublisher } from "../realtime/realtime.publisher.js";

import type {
  NotificationView,
  NotifyEnqueueInput,
  NotifyEnqueueResult,
  NotifyJobPayload,
} from "./notify.types.js";
import type { Notification, Prisma } from "@prisma/client";
import type { JobsOptions } from "bullmq";

export interface ListNotificationsInput {
  readonly userId: string;
  readonly unreadOnly?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface NotificationPage {
  readonly items: readonly Notification[];
  readonly nextCursor: string | null;
  /** Unread count for the badge, across every page. */
  readonly unread: number;
}

/**
 * The producer side of `notify`, and the in-app notification store.
 *
 * `enqueue` does three things and in this order:
 *
 * ```
 * notifications row (when the kind has one) → realtime notification.created → BullMQ job
 * ```
 *
 * The row is written first because it is the durable record: an email that fails
 * every retry still leaves the user something in the bell, whereas a row written
 * after a successful send would be missing exactly when delivery is broken. The
 * BullMQ job is last for the reason `JobsService.enqueue` puts it last — it is
 * the only step a consumer can observe, so nothing is half-done before it.
 *
 * Enqueueing never throws for a delivery reason. A caller is doing something else
 * (finishing a sign-up, closing an export) and a notification is a side effect of
 * that work, so a Redis hiccup is logged and swallowed exactly as
 * `RealtimePublisher` swallows one. The only exceptions raised are programming
 * errors: an unknown kind, or a missing recipient.
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly realtime: RealtimePublisher,
  ) {}

  // -------------------------------------------------------------------------
  // Producing
  // -------------------------------------------------------------------------

  async enqueue(input: NotifyEnqueueInput): Promise<NotifyEnqueueResult> {
    if (!isNotifyKind(input.kind)) {
      throw new AppException(
        NOTIFY_ERRORS.unknownKind,
        `"${String(input.kind)}" is not a notification kind.`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    const to = input.to.trim();
    if (to === "") {
      throw new AppException(
        ERROR_CODES.validationFailed,
        "A notification needs a recipient address.",
        HttpStatus.INTERNAL_SERVER_ERROR,
        { kind: input.kind },
      );
    }

    const idempotencyKey = normaliseKey(input.idempotencyKey ?? `${input.kind}-${ulid()}`);

    const notificationId = await this.writeInAppRow(input);

    const payload: NotifyJobPayload = {
      kind: input.kind,
      to,
      locale: input.locale ?? "en",
      data: input.data ?? {},
      idempotencyKey,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.devOutbox === undefined ? {} : { devOutbox: input.devOutbox }),
    };

    const envelope = buildJobEnvelope({
      // `notify` jobs have no `jobs` row: nothing bills them, nothing polls them
      // and no worker posts a completion callback for them. The two ids are still
      // minted because the envelope is frozen for every queue, and a fresh
      // `attemptId` is what makes each BullMQ job id unique.
      jobId: ulid(),
      attemptId: ulid(),
      workspaceId: input.workspaceId ?? NO_WORKSPACE,
      priority: isCriticalKind(input.kind) ? NOTIFY_PRIORITY.critical : NOTIFY_PRIORITY.standard,
      jobKey: idempotencyKey,
      createdAt: new Date(),
      payload: payload as unknown as Record<string, unknown>,
    });

    let enqueued = false;
    try {
      const job = await this.queues
        .queue("notify")
        .add(NOTIFY_JOB_NAME, envelope, this.jobOptions(idempotencyKey, envelope.priority));
      // BullMQ returns a job whose id is the one we asked for; when a job with
      // that id already exists it returns that one instead of adding a second.
      enqueued = job.id === idempotencyKey;
    } catch (error) {
      this.logger.error(
        { err: error, kind: input.kind, to: maskEmail(to) },
        "could not enqueue a notification",
      );
    }

    return {
      idempotencyKey,
      enqueued,
      ...(notificationId === undefined ? {} : { notificationId }),
    };
  }

  /**
   * BullMQ options for one notification.
   *
   * `jobId` is the idempotency key, which is what makes a duplicate enqueue a
   * no-op: BullMQ refuses to add a second job with an id it already holds, so a
   * webhook delivered twice sends one message. `removeOnComplete` is short — the
   * durable record is the `notifications` row and the audit trail, not Redis.
   */
  private jobOptions(idempotencyKey: string, priority: number): JobsOptions {
    const policy = retryPolicyFor("notify");
    return {
      jobId: idempotencyKey,
      priority,
      attempts: policy.attempts,
      backoff: { type: "exponential", delay: policy.backoffMs },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3_600, count: 5_000 },
    };
  }

  /** The `notifications` row and its realtime event, or `undefined` for kinds without one. */
  private async writeInAppRow(input: NotifyEnqueueInput): Promise<string | undefined> {
    if (!isInAppKind(input.kind) || input.userId === undefined) return undefined;

    const id = ulid();
    try {
      const row = await this.prisma.notification.create({
        data: {
          id,
          userId: input.userId,
          workspaceId: input.workspaceId ?? null,
          kind: input.kind,
          data: (input.data ?? {}) as Prisma.InputJsonValue,
        },
      });

      if (input.workspaceId !== undefined) {
        await this.realtime.notificationCreated(input.workspaceId, {
          notificationId: row.id,
          userId: row.userId,
          kind: row.kind,
          at: row.createdAt.toISOString(),
        });
      }
      return row.id;
    } catch (error) {
      // A foreign key that does not resolve (a user deleted mid-flight) must not
      // stop the email: the mailbox is the delivery of record.
      this.logger.warn({ err: error, kind: input.kind }, "could not write the in-app notification");
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Reading (the bell)
  // -------------------------------------------------------------------------

  async list(input: ListNotificationsInput): Promise<NotificationPage> {
    const limit = Math.min(input.limit ?? NOTIFICATIONS_PAGE_SIZE, NOTIFICATIONS_MAX_PAGE_SIZE);
    const where: Prisma.NotificationWhereInput = {
      userId: input.userId,
      ...(input.unreadOnly === true ? { readAt: null } : {}),
    };

    const rows = await this.prisma.notification.findMany({
      where,
      // Ids are ULIDs, so `id desc` is "newest first" AND a stable cursor; two
      // rows written in the same millisecond still order deterministically,
      // which `createdAt desc` alone would not guarantee.
      orderBy: { id: "desc" },
      take: limit + 1,
      ...(input.cursor === undefined ? {} : { cursor: { id: input.cursor }, skip: 1 }),
    });

    const unread = await this.prisma.notification.count({
      where: { userId: input.userId, readAt: null },
    });

    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
      unread,
    };
  }

  /**
   * Mark one notification read. Idempotent: a second call keeps the first
   * timestamp, so "when did they see it?" survives a double click.
   *
   * The `userId` is part of the `where`, not checked afterwards, so another
   * user's id is a 404 rather than a 403 — the same rule `JobsController` follows,
   * for the same reason: a 403 confirms that the id exists (THREAT-MODEL T5).
   */
  async markRead(id: string, userId: string): Promise<Notification> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });

    const row = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (row === null) {
      throw new AppException(
        NOTIFY_ERRORS.notFound,
        "No such notification.",
        HttpStatus.NOT_FOUND,
        { notificationId: id },
      );
    }
    if (count === 0) this.logger.debug({ notificationId: id }, "notification was already read");
    return row;
  }
}

/**
 * BullMQ custom job ids may not contain `:`, and the key ends up in a Redis key
 * name, so anything outside a conservative set becomes `-`.
 */
export function normaliseKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 200);
}

/** Prisma row → wire shape: `Date` becomes ISO-8601 (CONTRACTS §0). */
export function toNotificationView(row: Notification): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    workspaceId: row.workspaceId,
    data: row.data,
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
