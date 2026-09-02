import { z } from "zod";

import { NOTIFY_KINDS } from "./notify.kinds.js";

import type { NotifyKind } from "./notify.kinds.js";

/**
 * What one `notify` job carries.
 *
 * This is the brief's `{kind, to, locale, data, idempotencyKey}`, and it travels
 * as the `payload` of the CONTRACTS section 3 envelope rather than as the job's
 * whole `data`: the envelope is frozen for **every** queue, a future
 * `apps/notify` in another language would parse it, and wrapping costs one
 * nesting level. `NotifyService` builds the envelope; the consumer reads
 * `envelope.payload` and validates it with {@link NotifyJobPayloadSchema}.
 *
 * `data` is deliberately flat and scalar-only. Template variables are formatted
 * by ICU, which takes strings, numbers and booleans; a nested object would be a
 * variable no message can render and a place for a caller to smuggle a token
 * into a queue that outlives the request.
 */
export const NotifyDataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

export type NotifyData = z.infer<typeof NotifyDataSchema>;

export const NotifyJobPayloadSchema = z.object({
  kind: z.enum(NOTIFY_KINDS),
  /** One recipient. Validated at enqueue time, not here: the queue is internal. */
  to: z.string().min(3).max(320),
  locale: z.string().min(2).max(35),
  data: NotifyDataSchema,
  idempotencyKey: z.string().min(1).max(200),
  /** Written to `notifications` by the producer; the consumer only needs it for logs. */
  userId: z.string().length(26).optional(),
  workspaceId: z.string().length(26).optional(),
  /** A04's outbox fields, carried through so `MAIL_PROVIDER=dev` stays usable. */
  devOutbox: z
    .object({
      template: z.string().min(1).max(64),
      token: z.string().min(1).max(512).optional(),
      link: z.string().min(1).max(2_048).optional(),
    })
    .optional(),
});

export type NotifyJobPayload = z.infer<typeof NotifyJobPayloadSchema>;

/** What a producer hands {@link NotifyService.enqueue}. */
export interface NotifyEnqueueInput {
  readonly kind: NotifyKind;
  readonly to: string;
  /** BCP-47; anything without a catalogue falls back to English. */
  readonly locale?: string;
  readonly data?: NotifyData;
  /**
   * Makes the send at-most-once for one unit of work. Omit and one is derived
   * from `(kind, recipient, a fresh ULID)`, which deduplicates nothing — pass one
   * whenever the same message could legitimately be produced twice (a retried
   * webhook, a sweeper that runs every minute).
   */
  readonly idempotencyKey?: string;
  /** Recipient's user id. Required for the kinds that also appear in the bell. */
  readonly userId?: string;
  readonly workspaceId?: string;
  /** Development-outbox extras; only `MAIL_PROVIDER=dev` reads them. */
  readonly devOutbox?: NotifyJobPayload["devOutbox"];
}

export interface NotifyEnqueueResult {
  readonly idempotencyKey: string;
  /** `false` when a job with this key was already on the queue. */
  readonly enqueued: boolean;
  /** Id of the `notifications` row, when the kind writes one. */
  readonly notificationId?: string;
}

/** One in-app notification, as `GET /me/notifications` returns it. */
export interface NotificationView {
  readonly id: string;
  readonly kind: NotifyKind | string;
  readonly workspaceId: string | null;
  readonly data: unknown;
  readonly readAt: string | null;
  readonly createdAt: string;
}
