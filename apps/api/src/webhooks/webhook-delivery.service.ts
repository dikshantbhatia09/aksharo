import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { signWebhookPayload, WEBHOOK_SIGNATURE_HEADER } from "./webhook-signature.js";
import {
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
  WEBHOOK_ERRORS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_SCHEDULE_MS,
  WEBHOOK_SWEEP_BATCH,
} from "./webhooks.constants.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException, PrismaService } from "../common/index.js";
import { sendWebhook } from "../common/ssrf/webhook-fetch.js";

import type { WebhookEventName } from "./webhooks.constants.js";
import type { Prisma, WebhookDelivery } from "@prisma/client";

export interface EmitWebhookEventInput {
  readonly workspaceId: string;
  readonly event: WebhookEventName;
  readonly data: Record<string, unknown>;
}

/**
 * Fan out one product event to every active endpoint subscribed to it, and run
 * the retry state machine for deliveries already in flight (B14 §4).
 *
 * One `WebhookDelivery` row per (endpoint, event occurrence) — created here,
 * dispatched by {@link dispatchDue}, which `WebhookDeliverySweepTask` calls on a
 * timer rather than this service opening a BullMQ queue of its own: a webhook
 * delivery is exactly the kind of "poll a small due-table on an interval" work
 * `common/scheduler` already exists for (B16's retention sweeps are the same
 * shape), and it keeps this WP out of `jobs/contracts/queue-names.ts`, a frozen
 * CONTRACTS §3 list this brief does not ask to extend.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
  ) {}

  /** Create one pending delivery per active endpoint subscribed to `event`. */
  async emit(input: EmitWebhookEventInput): Promise<{ readonly deliveries: number }> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { workspaceId: input.workspaceId, active: true },
    });
    const subscribed = endpoints.filter((endpoint) => endpoint.events.includes(input.event));
    if (subscribed.length === 0) return { deliveries: 0 };

    const payload: Record<string, unknown> = {
      event: input.event,
      createdAt: new Date().toISOString(),
      data: input.data,
    };

    await this.prisma.webhookDelivery.createMany({
      data: subscribed.map((endpoint) => ({
        id: ulid(),
        endpointId: endpoint.id,
        event: input.event,
        payload: payload as Prisma.InputJsonValue,
        nextRetryAt: new Date(),
      })),
    });

    return { deliveries: subscribed.length };
  }

  /** `POST /workspaces/{id}/webhooks/{endpointId}/test` — a synthetic `ping` event. */
  async sendTestEvent(
    workspaceId: string,
    endpointId: string,
  ): Promise<{ readonly deliveryId: string }> {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, workspaceId },
    });
    if (endpoint === null) {
      throw new AppException(
        WEBHOOK_ERRORS.endpointNotFound,
        "No such webhook endpoint.",
        HttpStatus.NOT_FOUND,
      );
    }

    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        id: ulid(),
        endpointId: endpoint.id,
        event: "ping",
        payload: {
          event: "ping",
          createdAt: new Date().toISOString(),
          data: { message: "This is a test event from Aksharo." },
        } as Prisma.InputJsonValue,
        nextRetryAt: new Date(),
      },
    });
    return { deliveryId: delivery.id };
  }

  /** Re-arm an `exhausted`(`dead`) delivery for one more attempt (B14 §4: "manual redeliver"). */
  async redeliver(workspaceId: string, deliveryId: string): Promise<{ readonly id: string }> {
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: deliveryId, endpoint: { workspaceId } },
    });
    if (delivery === null) {
      throw new AppException(
        WEBHOOK_ERRORS.deliveryNotFound,
        "No such delivery.",
        HttpStatus.NOT_FOUND,
      );
    }

    const created = await this.prisma.webhookDelivery.create({
      data: {
        id: ulid(),
        endpointId: delivery.endpointId,
        event: delivery.event,
        payload: delivery.payload as Prisma.InputJsonValue,
        nextRetryAt: new Date(),
      },
    });
    return { id: created.id };
  }

  async listDeliveries(
    workspaceId: string,
    endpointId: string,
    limit = 50,
  ): Promise<readonly WebhookDelivery[]> {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, workspaceId },
    });
    if (endpoint === null) {
      throw new AppException(
        WEBHOOK_ERRORS.endpointNotFound,
        "No such webhook endpoint.",
        HttpStatus.NOT_FOUND,
      );
    }
    return this.prisma.webhookDelivery.findMany({
      where: { endpointId },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 200),
    });
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /** Dispatch every delivery whose `nextRetryAt` has arrived. Called by the sweep task. */
  async dispatchDue(now: Date = new Date()): Promise<{ readonly dispatched: number }> {
    const due = await this.prisma.webhookDelivery.findMany({
      where: { status: { in: ["pending", "failed"] }, nextRetryAt: { lte: now } },
      include: { endpoint: true },
      orderBy: { nextRetryAt: "asc" },
      take: WEBHOOK_SWEEP_BATCH,
    });

    for (const delivery of due) {
      if (!delivery.endpoint.active) {
        // Disabled mid-flight: stop retrying, but keep the row for the log.
        await this.prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: "dead", nextRetryAt: null },
        });
        continue;
      }
      await this.attempt(delivery);
    }
    return { dispatched: due.length };
  }

  private async attempt(
    delivery: WebhookDelivery & { readonly endpoint: { readonly id: string; readonly url: string; readonly secret: string; readonly workspaceId: string; readonly failureCount: number } },
  ): Promise<void> {
    const body = JSON.stringify(delivery.payload);
    const { header } = signWebhookPayload(delivery.endpoint.secret, body);
    const attemptNo = delivery.attempt;

    try {
      const result = await sendWebhook({
        url: delivery.endpoint.url,
        body,
        headers: {
          "content-type": "application/json",
          [WEBHOOK_SIGNATURE_HEADER]: header,
        },
        timeoutMs: WEBHOOK_DELIVERY_TIMEOUT_MS,
      });

      if (result.status >= 200 && result.status < 300) {
        await this.onSuccess(delivery, result.status);
        return;
      }
      await this.onFailure(delivery, attemptNo, `HTTP ${String(result.status)}`, result.status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.onFailure(delivery, attemptNo, message, null);
    }
  }

  private async onSuccess(delivery: WebhookDelivery, status: number): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "delivered",
          attempt: { increment: 1 },
          responseCode: status,
          error: null,
          nextRetryAt: null,
          deliveredAt: new Date(),
        },
      }),
      this.prisma.webhookEndpoint.update({
        where: { id: delivery.endpointId },
        data: { failureCount: 0 },
      }),
    ]);
  }

  private async onFailure(
    delivery: WebhookDelivery,
    attemptNo: number,
    error: string,
    responseCode: number | null,
  ): Promise<void> {
    const nextDelayMs = WEBHOOK_RETRY_SCHEDULE_MS[attemptNo - 1];
    const exhausted = attemptNo >= WEBHOOK_MAX_ATTEMPTS || nextDelayMs === undefined;

    await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: exhausted ? "dead" : "failed",
        attempt: { increment: 1 },
        error: error.slice(0, 500),
        ...(responseCode === null ? {} : { responseCode }),
        nextRetryAt: exhausted ? null : new Date(Date.now() + nextDelayMs),
      },
    });

    const endpoint = await this.prisma.webhookEndpoint.update({
      where: { id: delivery.endpointId },
      data: { failureCount: { increment: 1 } },
    });

    if (endpoint.failureCount >= WEBHOOK_AUTO_DISABLE_THRESHOLD && endpoint.active) {
      await this.autoDisable(endpoint.id, endpoint.workspaceId);
    }
  }

  /**
   * `webhook-endpoint-disabled` is not one of `notify.kinds.ts`'s closed set —
   * adding one is a name plus an English and Hindi template plus a row in three
   * tables in a module outside this WP's file boundaries (`notify/**`). The
   * notification the brief asks for is instead the audit trail (surfaced on the
   * Developers → Webhooks screen via `failures`/`disabledAt`, which
   * `WebhookEndpointsService.list` already returns) plus this log line an
   * operator's alerting can watch for. See the WP's final report for this as a
   * named deviation, and B14's "missing seam" for `notify/notify.kinds.ts` to
   * add a real `webhook-endpoint-disabled` email/in-app kind.
   */
  private async autoDisable(endpointId: string, workspaceId: string): Promise<void> {
    await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { active: false, disabledAt: new Date() },
    });
    this.logger.warn(
      { endpointId, workspaceId },
      `webhook endpoint auto-disabled after ${String(WEBHOOK_AUTO_DISABLE_THRESHOLD)} consecutive failures`,
    );
    await this.audit.record({
      action: "webhooks.endpoint.auto_disabled",
      resource: "webhook_endpoint",
      resourceId: endpointId,
      workspaceId,
      data: { threshold: WEBHOOK_AUTO_DISABLE_THRESHOLD },
    });
  }
}
