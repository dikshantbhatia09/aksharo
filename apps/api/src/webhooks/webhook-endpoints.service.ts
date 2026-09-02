import { randomBytes } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { WEBHOOK_ERRORS, WEBHOOK_EVENTS } from "./webhooks.constants.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException, PrismaService } from "../common/index.js";
import { resolveSafeTarget, SafeFetchError } from "../common/net/index.js";

import type { WebhookEventName } from "./webhooks.constants.js";
import type { WebhookEndpoint } from "@prisma/client";

export interface CreateWebhookInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly url: string;
  readonly events: readonly WebhookEventName[];
}

export interface WebhookEndpointView {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly active: boolean;
  readonly failures: number;
  readonly disabledAt: string | null;
  readonly createdAt: string;
}

export interface CreatedWebhookView extends WebhookEndpointView {
  /** Shown once, at creation. Never returned by any other call. */
  readonly secret: string;
}

/**
 * Webhook endpoint CRUD (B14 §4/§5): the `Settings → Developers` webhooks table
 * and its "send test event" button.
 *
 * The URL is validated **https-only and SSRF-guarded at creation time** the same
 * way `common/ssrf/webhook-fetch.ts` re-validates it at delivery time — a
 * workspace should not be able to save `http://169.254.169.254/` and have it sit
 * there looking configured. Re-validating on every delivery (rather than trusting
 * this one-time check) is what actually stops rebinding; this check exists so
 * the mistake is caught immediately instead of silently producing failed
 * deliveries.
 */
@Injectable()
export class WebhookEndpointsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
  ) {}

  async create(input: CreateWebhookInput): Promise<CreatedWebhookView> {
    await this.assertSafeUrl(input.url);
    const secret = `whsec_${randomBytes(24).toString("hex")}`;

    const row = await this.prisma.webhookEndpoint.create({
      data: {
        id: ulid(),
        workspaceId: input.workspaceId,
        url: input.url,
        secret,
        events: [...input.events],
      },
    });

    await this.audit.record({
      action: "webhooks.endpoint.created",
      resource: "webhook_endpoint",
      resourceId: row.id,
      actorId: input.userId,
      workspaceId: input.workspaceId,
      data: { url: input.url, events: input.events },
    });

    return { ...toView(row), secret };
  }

  async list(workspaceId: string): Promise<readonly WebhookEndpointView[]> {
    const rows = await this.prisma.webhookEndpoint.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toView);
  }

  async update(
    workspaceId: string,
    userId: string,
    endpointId: string,
    input: { readonly url?: string; readonly events?: readonly WebhookEventName[]; readonly active?: boolean },
  ): Promise<WebhookEndpointView> {
    const existing = await this.require(workspaceId, endpointId);
    if (input.url !== undefined) await this.assertSafeUrl(input.url);

    const row = await this.prisma.webhookEndpoint.update({
      where: { id: existing.id },
      data: {
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.events === undefined ? {} : { events: [...input.events] }),
        ...(input.active === undefined
          ? {}
          : {
              active: input.active,
              disabledAt: input.active ? null : new Date(),
              failureCount: input.active ? 0 : existing.failureCount,
            }),
      },
    });

    await this.audit.record({
      action: "webhooks.endpoint.updated",
      resource: "webhook_endpoint",
      resourceId: row.id,
      actorId: userId,
      workspaceId,
      data: input,
    });

    return toView(row);
  }

  async revoke(workspaceId: string, userId: string, endpointId: string): Promise<{ id: string }> {
    const existing = await this.require(workspaceId, endpointId);
    await this.prisma.webhookEndpoint.delete({ where: { id: existing.id } });

    await this.audit.record({
      action: "webhooks.endpoint.deleted",
      resource: "webhook_endpoint",
      resourceId: existing.id,
      actorId: userId,
      workspaceId,
    });

    return { id: existing.id };
  }

  async require(workspaceId: string, endpointId: string): Promise<WebhookEndpoint> {
    const row = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, workspaceId },
    });
    if (row === null) {
      throw new AppException(
        WEBHOOK_ERRORS.endpointNotFound,
        "No such webhook endpoint.",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private async assertSafeUrl(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppException(
        WEBHOOK_ERRORS.invalidUrl,
        "Not a valid URL.",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (parsed.protocol !== "https:") {
      throw new AppException(
        WEBHOOK_ERRORS.invalidUrl,
        "Webhook endpoints must be https.",
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      await resolveSafeTarget(url, { allowedPorts: [443] });
    } catch (error) {
      const reason = error instanceof SafeFetchError ? error.message : "could not verify the host";
      throw new AppException(
        WEBHOOK_ERRORS.invalidUrl,
        `This URL cannot be used as a webhook endpoint: ${reason}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}

function toView(row: WebhookEndpoint): WebhookEndpointView {
  return {
    id: row.id,
    url: row.url,
    events: row.events.filter((event): event is WebhookEventName =>
      (WEBHOOK_EVENTS as readonly string[]).includes(event),
    ),
    active: row.active,
    failures: row.failureCount,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
