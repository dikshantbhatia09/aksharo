import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  AdminSupportTicketDto,
  ListSupportTicketsQueryDto,
  ReplyToTicketDto,
  SetTicketStatusDto,
} from "./admin-support.dto.js";
import { AdminSupportService } from "./admin-support.service.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AdminRoles } from "../admin-roles.decorator.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";

/**
 * `admin/support`: B12's `support_tickets` queue (brief §2: "support tickets
 * (B12) with replies via the notify interface"). Listing and viewing a
 * ticket are open to any admin session (support work is read-mostly and
 * every panel is already gated by `AdminGuard`); changing status or replying
 * is restricted to the `support` role (and `superadmin`, per `AdminGuard`'s
 * own rule that it always satisfies any narrower `@AdminRoles`) — the same
 * shape as `AdminShareController`'s `ops`/`content`-gated `resolve`.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "Requires an admin session." })
@UseGuards(AdminGuard)
@Controller("admin/support")
export class AdminSupportController {
  constructor(
    private readonly support: AdminSupportService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get("tickets")
  @ApiOperation({
    summary: "Support tickets, newest first, optionally filtered by status/category",
    operationId: "adminListSupportTickets",
  })
  @ApiOkResponse({ type: [AdminSupportTicketDto] })
  async list(@Query() query: ListSupportTicketsQueryDto): Promise<AdminSupportTicketDto[]> {
    return this.support.list(query);
  }

  @Get("tickets/:id")
  @ApiOperation({ summary: "One ticket", operationId: "adminGetSupportTicket" })
  @ApiOkResponse({ type: AdminSupportTicketDto })
  @ApiNotFoundResponse({ description: "`common/not_found`." })
  async get(@Param("id") id: string): Promise<AdminSupportTicketDto> {
    return this.support.get(id);
  }

  @Post("tickets/:id/status")
  @AdminRoles("support", "superadmin")
  @ApiOperation({
    summary: "Move a ticket to open/in_progress/resolved/closed",
    operationId: "adminSetSupportTicketStatus",
  })
  @ApiOkResponse({ type: AdminSupportTicketDto })
  @ApiNotFoundResponse({ description: "`common/not_found`." })
  async setStatus(
    @Param("id") id: string,
    @Body() body: SetTicketStatusDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminSupportTicketDto> {
    const admin = adminOf(request);
    const before = await this.support.get(id);
    const ticket = await this.support.setStatus(id, body.status);
    await this.audit.record({
      action: "admin.support.status_set",
      resource: "support_ticket",
      resourceId: id,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: { before: before.status, after: body.status },
    });
    return ticket;
  }

  @Post("tickets/:id/reply")
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminRoles("support", "superadmin")
  @ApiOperation({
    summary: "Reply to a ticket via the notify interface",
    operationId: "adminReplyToSupportTicket",
  })
  @ApiNotFoundResponse({ description: "`common/not_found`." })
  async reply(
    @Param("id") id: string,
    @Body() body: ReplyToTicketDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const admin = adminOf(request);
    await this.support.get(id); // 404s before anything is recorded
    await this.support.reply(id, body.body);
    await this.audit.record({
      action: "admin.support.replied",
      resource: "support_ticket",
      resourceId: id,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: { reply: body.body },
    });
  }
}
