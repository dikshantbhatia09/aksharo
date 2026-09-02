import { Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { BRAND } from "@montaj/config";

import { PrismaService } from "../common/prisma/prisma.service.js";
import { NotifyService } from "../notify/notify.service.js";

import type { CreateSupportTicketInput, ListSupportTicketsResponse, SupportTicketView } from "./support.dto.js";
import type { SupportTicket } from "@prisma/client";

function toView(ticket: SupportTicket): SupportTicketView {
  return {
    id: ticket.id,
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status,
    hasDiagnostics: ticket.diagnostics !== null,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

/**
 * `/support/tickets` (brief §5): file a ticket, optionally with a
 * consent-gated diagnostics bundle, list your own workspace's tickets, email
 * `BRAND.supportEmail` via `notify`. B13's admin console reads the same
 * `support_tickets` table for its queue and status transitions — this
 * service is the only writer, so B13 stays a reader plus a status-transition
 * call this module can add later without either side re-deriving the model.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
  ) {}

  async createTicket(
    workspaceId: string,
    userId: string,
    input: CreateSupportTicketInput,
  ): Promise<SupportTicketView> {
    const ticket = await this.prisma.supportTicket.create({
      data: {
        id: ulid(),
        workspaceId,
        userId,
        subject: input.subject,
        body: input.body,
        category: input.category,
        diagnostics: input.diagnostics ?? undefined,
      },
    });

    // A support email is a side effect of filing the ticket, not the ticket
    // itself — a Redis hiccup here must not turn a filed ticket into a 500
    // (`NotifyService.enqueue`'s own contract: it only throws for a caller
    // bug, and this call site never wants that to become the ticket's own
    // failure either).
    try {
      await this.notify.enqueue({
        kind: "support-ticket-created",
        to: BRAND.supportEmail,
        data: {
          subject: input.subject,
          category: input.category,
          workspaceId,
          ticketId: ticket.id,
          diagnostics: input.diagnostics ? "attached" : "not attached",
        },
        idempotencyKey: `support-ticket-created-${ticket.id}`,
      });
    } catch (error) {
      this.logger.error({ err: error, ticketId: ticket.id }, "support ticket email failed to enqueue");
    }

    return toView(ticket);
  }

  async listTickets(workspaceId: string): Promise<ListSupportTicketsResponse> {
    const tickets = await this.prisma.supportTicket.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return { tickets: tickets.map(toView) };
  }
}
