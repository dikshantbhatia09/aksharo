import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { InvoicesService } from "./invoices.service.js";
import { CurrentUser, JwtAuthGuard, RolesGuard } from "../common/guards/index.js";
import { PrismaService } from "../common/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * Customer-facing invoice surface: list and download. Rendering a nice
 * billing-history page is B03's job (brief "out of scope: UI"); this is the
 * minimal API surface that page would call.
 *
 * Scoped through the access token via {@link WorkspaceMemberGuard}, the same
 * convention `/billing/*` uses (`billing.controller.ts`) — every route here
 * reads the caller's own workspace's invoices only, never another
 * workspace's by id.
 */
@ApiTags("invoices")
@Controller("invoices")
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "List the caller's workspace's invoices, most recent first." })
  @ApiOkResponse()
  async list(@CurrentUser() principal: AuthPrincipal): Promise<unknown> {
    return this.prisma.invoice.findMany({
      where: { workspaceId: principal.workspaceId },
      orderBy: { issuedAt: "desc" },
    });
  }

  // The route param is `:invoiceId`, not `:id` — `WorkspaceMemberGuard`
  // special-cases a literal `id` param as the workspace id (07 §Conventions),
  // exactly the reason `billing.controller.ts`'s mandate-revoke route does the
  // same (its own comment explains the bug this avoids).
  @Get(":invoiceId/download")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "A short-lived signed URL for the invoice PDF." })
  @ApiOkResponse()
  async download(@Param("invoiceId") invoiceId: string, @CurrentUser() principal: AuthPrincipal) {
    const url = await this.invoices.getDownloadUrl(invoiceId, principal.workspaceId);
    return { url };
  }
}
