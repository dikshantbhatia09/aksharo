import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { AdminDunningEntryDto, AdminRefundDto, AdminRefundResultDto } from "./admin-billing.dto.js";
import { AdminBillingService } from "./admin-billing.service.js";
import { clientIp } from "../../common/guards/principal.js";
import { AdminRoles } from "../admin-roles.decorator.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";

/**
 * Admin refunds + credit notes (B13 scope §2). `finance`/`superadmin` only —
 * `support` may view (the read-only users/workspaces panel) but not move
 * money, per the brief's own e2e requirement.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({
  description: "Requires an admin session with the finance or superadmin role.",
})
@UseGuards(AdminGuard)
@Controller("admin/billing")
export class AdminBillingController {
  constructor(private readonly billing: AdminBillingService) {}

  @Get("dunning")
  @ApiOperation({
    summary: "Subscriptions past due, with mandate status and next actions",
    description:
      "Read-only monitor: `graceUntil` (D40's 3-day entitlement grace) and `renewalInitiateAt` " +
      "(the 48h-ahead retry) are the two 'what happens next, when' fields; the mandate ladder " +
      "itself is billing/dunning.ts, unchanged by this WP.",
    operationId: "adminDunningMonitor",
  })
  @ApiOkResponse({ type: [AdminDunningEntryDto] })
  async dunning(): Promise<AdminDunningEntryDto[]> {
    return this.billing.dunningMonitor();
  }

  @Post("passes/:passPurchaseId/refund")
  @HttpCode(HttpStatus.OK)
  @AdminRoles("finance", "superadmin")
  @ApiOperation({
    summary:
      "Refund a pass/top-up purchase under the 7-day-full / pro-rata policy, and issue a credit note",
    description:
      "Within 7 days of purchase: full refund of the amount on file. After 7 days: pro-rated " +
      "by the fraction of the purchase's credits still unspent. Claws back the credits via B01's " +
      "RefundsService and, when the purchase has an original tax invoice, issues a B05 credit " +
      "note for the refunded amount. `reason` is mandatory.",
    operationId: "adminRefundPassPurchase",
  })
  @ApiOkResponse({ type: AdminRefundResultDto })
  @ApiNotFoundResponse({ description: "`common/not_found` — no such purchase, or no lot on file." })
  @ApiConflictResponse({ description: "Already refunded, or the policy-computed amount is zero." })
  async refund(
    @Param("passPurchaseId") passPurchaseId: string,
    @Body() body: AdminRefundDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminRefundResultDto> {
    const admin = adminOf(request);
    return this.billing.refundPassPurchase(passPurchaseId, body, admin, clientIp(request));
  }
}
