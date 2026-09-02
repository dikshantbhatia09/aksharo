import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { UnrecoverableError, Worker } from "bullmq";

import type { Env } from "@montaj/config";

import { MAIL_PROVIDER } from "./mail/mail.provider.js";
import {
  DELIVERY_RECEIPT_TTL_SEC,
  NOTIFY_WORKER_CONCURRENCY,
  RECIPIENT_RATE_LIMIT,
  notifyRedisKeys,
  notifyWorkerEnabled,
} from "./notify.constants.js";
import { allowsUnsubscribe, isCriticalKind } from "./notify.kinds.js";
import { NotifyJobPayloadSchema } from "./notify.types.js";
import { SuppressionService } from "./suppression.service.js";
import { renderNotification, TemplateRenderError } from "./templates/render.js";
import { maskEmail, RateLimitService, RedisService } from "../common/index.js";
import { ENV } from "../config/config.module.js";
import { isJobEnvelope } from "../jobs/contracts/job-envelope.js";
import { queuePrefix } from "../jobs/jobs.config.js";
import { QueueRegistry } from "../jobs/queue.registry.js";

import type { MailMessage, MailProvider } from "./mail/mail.provider.js";
import type { NotifyJobPayload } from "./notify.types.js";
import type { Job as BullJob } from "bullmq";

/** What one job did, for the log line and for the unit tests. */
export type DeliveryOutcome = "sent" | "suppressed" | "rate-limited" | "duplicate";

/**
 * The `notify` consumer: one BullMQ `Worker` inside the API process.
 *
 * **Why in the API and not an `apps/notify`.** Sending a message is a render and
 * one HTTPS call — no ffmpeg, no GPU, no model — so a separate deployable would
 * add a rollout, a dashboard and an on-call surface for work the API is already
 * sized for, and would still need the same database and the same Redis.
 * `NOTIFY_WORKER_ENABLED=0` turns it off for the processes that must not run one
 * (the OpenAPI emitter, test suites with a substituted Redis), and moving it out
 * later is a new package that imports this class and nothing else changes.
 *
 * The order inside one job is the point:
 *
 * ```
 * envelope → payload → suppression → per-recipient limit → receipt → render → send → receipt
 * ```
 *
 * Suppression comes before everything because a suppressed address must not even
 * be rendered for. The receipt is checked before the render and written after the
 * send, which makes a retry after a successful send a no-op: `attempts: 5` on the
 * `notify` queue means the failure modes worth retrying (a relay that refused, an
 * SES throttle) get five goes, and the one thing that must never happen twice is
 * a message the recipient already has.
 *
 * A malformed job or an unrenderable template throws `UnrecoverableError`: no
 * amount of retrying fixes a payload, and five attempts at it only delays the
 * moment somebody looks at the dead-letter queue.
 */
@Injectable()
export class NotifyConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotifyConsumer.name);
  private readonly prefix = queuePrefix();
  private worker?: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly queues: QueueRegistry,
    private readonly suppression: SuppressionService,
    private readonly limiter: RateLimitService,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  onApplicationBootstrap(): void {
    if (!notifyWorkerEnabled()) {
      this.logger.log("notify consumer disabled (NOTIFY_WORKER_ENABLED=0)");
      return;
    }

    this.worker = new Worker("notify", async (job: BullJob) => this.handle(job), {
      connection: this.redis.client,
      prefix: this.prefix,
      concurrency: NOTIFY_WORKER_CONCURRENCY,
    });
    this.worker.on("error", (error: Error) => {
      // A worker must not take the API down because Redis blinked.
      this.logger.warn({ err: error.message }, "notify worker error");
    });
    this.worker.on("failed", (job: BullJob | undefined, error: Error) => {
      this.logger.error(
        { attempt: job?.attemptsMade, err: error.message },
        "notification delivery failed",
      );
    });
    this.logger.log(`notify consumer running (${this.mail.name})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
    await this.mail.close?.();
  }

  /** True while this process is draining the queue. */
  get running(): boolean {
    return this.worker !== undefined;
  }

  /**
   * Wait until the queue has nothing left to do.
   *
   * The test seam, and the reason `test/auth-harness.ts` can still read a token
   * straight out of the outbox: delivery became asynchronous when A25 took it
   * over, so a suite that used to read a Redis list written inline now waits for
   * the queue instead of sleeping and hoping. Returns `false` on timeout rather
   * than throwing, so a caller decides whether that is a failure.
   */
  async drain(timeoutMs = 5_000): Promise<boolean> {
    const queue = this.queues.queue("notify");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "prioritized");
      const outstanding = Object.values(counts).reduce((total, count) => total + count, 0);
      if (outstanding === 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // -------------------------------------------------------------------------
  // One job
  // -------------------------------------------------------------------------

  async handle(job: BullJob): Promise<DeliveryOutcome> {
    const payload = this.payloadOf(job.data);
    return this.deliver(payload);
  }

  /** Envelope (CONTRACTS §3) → the notify payload, or an unrecoverable failure. */
  private payloadOf(data: unknown): NotifyJobPayload {
    const inner = isJobEnvelope(data) ? data.payload : data;
    const parsed = NotifyJobPayloadSchema.safeParse(inner);
    if (!parsed.success) {
      throw new UnrecoverableError(
        `notify job payload is not valid: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
      );
    }
    return parsed.data;
  }

  /** Exposed for the unit suite, which drives one delivery without a queue. */
  async deliver(payload: NotifyJobPayload): Promise<DeliveryOutcome> {
    const suppressed = await this.suppression.lookup(payload.to);
    if (suppressed !== null) {
      // A hard bounce or a complaint stops everything, including the critical
      // kinds: continuing to send to an address that complained is what gets a
      // sending domain blocked, and the recipient cannot read any of it anyway.
      await this.suppression.recordSkip(payload.to, payload.kind, suppressed);
      this.logger.log(
        { kind: payload.kind, to: maskEmail(payload.to), reason: suppressed.reason },
        "delivery skipped: address is suppressed",
      );
      return "suppressed";
    }

    if (!isCriticalKind(payload.kind) && !(await this.withinRecipientLimit(payload.to))) {
      this.logger.warn(
        { kind: payload.kind, to: maskEmail(payload.to) },
        "delivery skipped: recipient hourly limit",
      );
      return "rate-limited";
    }

    if (await this.alreadyDelivered(payload.idempotencyKey)) {
      this.logger.debug({ kind: payload.kind }, "delivery skipped: already sent");
      return "duplicate";
    }

    const message = this.render(payload);
    await this.mail.send(message);
    await this.recordDelivery(payload.idempotencyKey);

    this.logger.log(
      { kind: payload.kind, to: maskEmail(payload.to), provider: this.mail.name },
      "notification delivered",
    );
    return "sent";
  }

  private render(payload: NotifyJobPayload): MailMessage {
    const unsubscribeUrl = new URL("/settings/notifications", this.env.WEB_ORIGIN).toString();
    let rendered;
    try {
      rendered = renderNotification({
        kind: payload.kind,
        locale: payload.locale,
        data: payload.data,
        unsubscribeUrl,
      });
    } catch (error) {
      // A variable the caller did not send is a bug in the caller. Retrying it
      // five times produces five identical failures and one late diagnosis.
      throw new UnrecoverableError(
        error instanceof TemplateRenderError ? error.message : String(error),
      );
    }

    const unsubscribe = allowsUnsubscribe(payload.kind);
    return {
      to: payload.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      // Tags are for provider-side reporting and are visible in CloudWatch, so
      // they carry the kind and the locale and never an address or a token.
      tags: { kind: payload.kind, locale: rendered.locale },
      ...(unsubscribe
        ? {
            headers: {
              "List-Unsubscribe": `<${unsubscribeUrl}>`,
              // RFC 8058: tells Gmail and friends that the one-click unsubscribe
              // is a POST, which is what turns the header into a real button.
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          }
        : {}),
      idempotencyKey: payload.idempotencyKey,
      ...(payload.devOutbox === undefined ? {} : { devOutbox: payload.devOutbox }),
    };
  }

  /** Ten non-critical messages an hour to one mailbox (brief §2). */
  private async withinRecipientLimit(to: string): Promise<boolean> {
    const verdict = await this.limiter.consume(RECIPIENT_RATE_LIMIT, SuppressionService.hash(to));
    return verdict.allowed;
  }

  private async alreadyDelivered(idempotencyKey: string): Promise<boolean> {
    try {
      return (await this.redis.client.exists(notifyRedisKeys.delivered(idempotencyKey))) === 1;
    } catch (error) {
      // Fail open: a lost receipt means at worst a duplicate message, whereas
      // failing closed means a verification link that never arrives.
      this.logger.warn({ err: error }, "could not read the delivery receipt");
      return false;
    }
  }

  private async recordDelivery(idempotencyKey: string): Promise<void> {
    try {
      await this.redis.client.set(
        notifyRedisKeys.delivered(idempotencyKey),
        new Date().toISOString(),
        "EX",
        DELIVERY_RECEIPT_TTL_SEC,
      );
    } catch (error) {
      this.logger.warn({ err: error }, "could not write the delivery receipt");
    }
  }
}
