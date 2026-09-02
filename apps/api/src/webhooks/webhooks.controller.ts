import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { WebhookDeliveryService } from "./webhook-delivery.service.js";
import {
  WebhookEndpointsService,
  type CreatedWebhookView,
  type WebhookEndpointView,
} from "./webhook-endpoints.service.js";
import {
  CreatedWebhookEndpointDto,
  CreateWebhookRequestDto,
  UpdateWebhookRequestDto,
  WebhookDeliveryDto,
  WebhookEndpointDto,
  WebhookRedeliverResultDto,
  WebhookTestResultDto,
} from "./webhooks.dto.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { LogAccess } from "../privacy/access-log.decorator.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * `Settings → Developers → Webhooks` (B14 §5): endpoint CRUD, the "send test
 * event" button and the delivery log.
 *
 * Web-session (JWT) only — creating or rotating a webhook endpoint is an
 * account-management action, not something an API key does; `webhooks_manage`
 * is the *API key* scope a caller uses to read this same data over `/v1`
 * (nowhere yet — read-scoped webhook access via `webhooks_manage` is not wired to `/v1`) if it ever needs to, but the CRUD
 * surface itself lives here next to `brand-assets`, `teams` and the rest of
 * `Settings`.
 */
@ApiTags("webhooks")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("workspaces/:id/webhooks")
export class WebhooksController {
  constructor(
    private readonly endpoints: WebhookEndpointsService,
    private readonly delivery: WebhookDeliveryService,
  ) {}

  @Post()
  @Roles("admin")
  @ApiOperation({ summary: "Register a webhook endpoint", operationId: "createWebhookEndpoint" })
  @ApiOkResponse({ type: CreatedWebhookEndpointDto })
  async create(
    @CurrentUser() principal: AuthPrincipal,
    @Param("id") workspaceId: string,
    @Body() body: CreateWebhookRequestDto,
  ): Promise<CreatedWebhookView> {
    return this.endpoints.create({
      workspaceId,
      userId: principal.userId,
      url: body.url,
      events: body.events,
    });
  }

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "List a workspace's webhook endpoints",
    operationId: "listWebhookEndpoints",
  })
  @ApiOkResponse({ type: [WebhookEndpointDto] })
  @LogAccess("webhooks.endpoint.list")
  async list(@Param("id") workspaceId: string): Promise<readonly WebhookEndpointView[]> {
    return this.endpoints.list(workspaceId);
  }

  @Patch(":endpointId")
  @Roles("admin")
  @ApiOperation({
    summary: "Update a webhook endpoint's URL, events or active state",
    operationId: "updateWebhookEndpoint",
  })
  @ApiOkResponse({ type: WebhookEndpointDto })
  @ApiNotFoundResponse({ description: "`webhooks/endpoint_not_found`." })
  async update(
    @CurrentUser() principal: AuthPrincipal,
    @Param("id") workspaceId: string,
    @Param("endpointId") endpointId: string,
    @Body() body: UpdateWebhookRequestDto,
  ): Promise<WebhookEndpointView> {
    return this.endpoints.update(workspaceId, principal.userId, endpointId, body);
  }

  @Delete(":endpointId")
  @Roles("admin")
  @ApiOperation({ summary: "Remove a webhook endpoint", operationId: "deleteWebhookEndpoint" })
  @ApiOkResponse({ type: WebhookEndpointDto })
  @ApiNotFoundResponse({ description: "`webhooks/endpoint_not_found`." })
  async remove(
    @CurrentUser() principal: AuthPrincipal,
    @Param("id") workspaceId: string,
    @Param("endpointId") endpointId: string,
  ): Promise<{ id: string }> {
    return this.endpoints.revoke(workspaceId, principal.userId, endpointId);
  }

  @Post(":endpointId/test")
  @Roles("admin")
  @ApiOperation({
    summary: "Send a synthetic `ping` event to this endpoint",
    operationId: "sendWebhookTestEvent",
  })
  @ApiOkResponse({ type: WebhookTestResultDto })
  @ApiNotFoundResponse({ description: "`webhooks/endpoint_not_found`." })
  async test(
    @Param("id") workspaceId: string,
    @Param("endpointId") endpointId: string,
  ): Promise<WebhookTestResultDto> {
    return this.delivery.sendTestEvent(workspaceId, endpointId);
  }

  @Get(":endpointId/deliveries")
  @Roles("viewer")
  @ApiOperation({
    summary: "This endpoint's recent delivery log",
    operationId: "listWebhookDeliveries",
  })
  @ApiOkResponse({ type: [WebhookDeliveryDto] })
  @ApiNotFoundResponse({ description: "`webhooks/endpoint_not_found`." })
  async deliveries(
    @Param("id") workspaceId: string,
    @Param("endpointId") endpointId: string,
  ): Promise<readonly WebhookDeliveryDto[]> {
    const rows = await this.delivery.listDeliveries(workspaceId, endpointId);
    return rows.map((row) => ({
      id: row.id,
      event: row.event,
      status: row.status,
      attempt: row.attempt,
      responseCode: row.responseCode,
      error: row.error,
      nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  @Post("deliveries/:deliveryId/redeliver")
  @Roles("admin")
  @ApiOperation({
    summary: "Manually redeliver an exhausted delivery",
    operationId: "redeliverWebhookDelivery",
  })
  @ApiOkResponse({ type: WebhookRedeliverResultDto })
  @ApiNotFoundResponse({ description: "`webhooks/delivery_not_found`." })
  async redeliver(
    @Param("id") workspaceId: string,
    @Param("deliveryId") deliveryId: string,
  ): Promise<WebhookRedeliverResultDto> {
    return this.delivery.redeliver(workspaceId, deliveryId);
  }
}
