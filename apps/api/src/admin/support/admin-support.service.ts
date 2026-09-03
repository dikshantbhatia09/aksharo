import { HttpStatus, Injectable } from "@nestjs/common";

import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { NotifyService } from "../../notify/notify.service.js";

import type { AdminSupportTicketDto, ListSupportTicketsQueryDto } from "./admin-support.dto.js";
import type { SupportTicket } from "@prisma/client";

function toDto(ticket: SupportTicket): AdminSupportTicketDto {
  return {
    id: ticket.id,
    workspaceId: ticket.workspaceId,
    userId: ticket.userId,
    subject: ticket.subject,
    body: ticket.body,
    category: ticket.category,
    status: ticket.status,
    hasDiagnostics: ticket.diagnostics !== null,
    diagnostics: ticket.diagnostics,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

/**
 * The admin side of B12's `support_tickets` (brief §5 owns creation and the
 * requester's own list; `support.service.ts`'s own doc comment names this
 * exact seam: "this service is the only writer [today] ... plus a
 * status-transition call this module can add later"). The schema itself
 * settles who owns the status column — `SupportTicket.status`'s comment
 * reads "B13 (admin) transitions it" — so this service writes `status`
 * directly rather than routing back through `SupportService`, the same way
 * `AdminShareController` writes `share_reports.resolved_at` directly rather
 * than adding a mutator to a module it does not own.
 *
 * There is no separate reply-thread table: a reply is a `support-ticket-reply`
 * notification to the ticket's own user (brief §2: "replies via the notify
 * interface") and an `audit_log` row carrying the reply text — the durable
 * record of what was said is the notification outbox plus the audit trail,
 * not a second copy of the message in a table this WP would have to invent.
 */
@Injectable()
export class AdminSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
  ) {}

  async list(query: ListSupportTicketsQueryDto): Promise<AdminSupportTicketDto[]> {
    const tickets = await this.prisma.supportTicket.findMany({
      where: {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.category === undefined ? {} : { category: query.category }),
      },
      orderBy: { createdAt: "desc" },
    });
    return tickets.map(toDto);
  }

  async get(id: string): Promise<AdminSupportTicketDto> {
    const ticket = await this.findOrThrow(id);
    return toDto(ticket);
  }

  async setStatus(id: string, status: string): Promise<AdminSupportTicketDto> {
    await this.findOrThrow(id);
    const ticket = await this.prisma.supportTicket.update({ where: { id }, data: { status } });
    return toDto(ticket);
  }

  /**
   * Emails (and, per `IN_APP_KINDS`, bells) the ticket's own user. Best-effort
   * like every other notify call site in this codebase — see
   * `SupportService.createTicket`'s identical comment — a delivery hiccup
   * must not turn a saved reply into a 500.
   */
  async reply(id: string, body: string): Promise<void> {
    const ticket = await this.findOrThrow(id);
    const user = await this.prisma.user.findUnique({
      where: { id: ticket.userId },
      select: { email: true },
    });
    if (user === null) return;

    await this.notify.enqueue({
      kind: "support-ticket-reply",
      to: user.email,
      userId: ticket.userId,
      workspaceId: ticket.workspaceId,
      data: { subject: ticket.subject, replyBody: body, ticketId: ticket.id },
      idempotencyKey: `support-ticket-reply-${ticket.id}-${String(Date.now())}`,
    });
  }

  private async findOrThrow(id: string): Promise<SupportTicket> {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (ticket === null) {
      throw new AppException(ERROR_CODES.notFound, "No such ticket.", HttpStatus.NOT_FOUND);
    }
    return ticket;
  }
}
