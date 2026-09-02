import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  CreateSupportTicketDto,
  listSupportTicketsResponseSchema,
  supportTicketViewSchema,
  type ListSupportTicketsResponse,
  type SupportTicketView,
} from "./support.dto.js";
import { SupportService } from "./support.service.js";
import { zodResponse } from "../auth/dto/openapi.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * `/support/tickets` (B12): file a ticket (with an optional consent-gated
 * diagnostics bundle) and list this workspace's own tickets — Settings →
 * Support. B13's admin console reads `support_tickets` directly rather than
 * through this controller (an admin surface, guarded by `AdminGuard`, not a
 * workspace member's).
 */
@ApiTags("support")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("support/tickets")
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly audit: CommonAuditService,
  ) {}

  @Post()
  @Roles("viewer")
  @ApiOperation({
    summary: "File a support ticket",
    description:
      "Diagnostics (app version, browser/OS, workspace id, last 10 job ids/statuses, a " +
      "console-error ring buffer — never media) are included only when the caller opted in " +
      "and attaches the `diagnostics` field.",
    operationId: "createSupportTicket",
  })
  @ApiOkResponse(zodResponse(supportTicketViewSchema, "The created ticket."))
  async create(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: CreateSupportTicketDto,
  ): Promise<SupportTicketView> {
    const ticket = await this.support.createTicket(principal.workspaceId, principal.userId, body);
    await this.audit.record({
      action: "support.ticket.created",
      resource: "support_ticket",
      resourceId: ticket.id,
      actorId: principal.userId,
      workspaceId: principal.workspaceId,
      data: { category: ticket.category, hasDiagnostics: ticket.hasDiagnostics },
    });
    return ticket;
  }

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "This workspace's support tickets",
    operationId: "listSupportTickets",
  })
  @ApiOkResponse(zodResponse(listSupportTicketsResponseSchema, "Newest first."))
  async list(@CurrentUser() principal: AuthPrincipal): Promise<ListSupportTicketsResponse> {
    return this.support.listTickets(principal.workspaceId);
  }
}
