import { Controller, Get, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  offersEligibilityViewSchema,
  passViewSchema,
  type OffersEligibilityView,
  type PassView,
} from "./offers.dto.js";
import { OffersService } from "./offers.service.js";
import { zodArrayResponse, zodResponse } from "../auth/dto/openapi.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * `/offers/*` (B04): what the export-dialog upsell panel and the Subscription
 * overview's pass chips render.
 *
 * Same guard stack as `/billing/*` and `/exports/*` — no `:id` in the path,
 * scoped through the access token via `WorkspaceMemberGuard`. The dev-only
 * payment simulator (`POST /offers/dev/simulate-nine-pass-payment`, same URL
 * space) is a separate controller class, `offers-dev.controller.ts` —
 * registered under `BillingModule`'s `controllers` array instead of here,
 * because it needs `BILLING_PROVIDER` and `WebhooksService`, both native to
 * that module (Nest routes are global regardless of which module registers
 * the controller; only dependency resolution is module-scoped). Keeping it
 * there avoids `OffersModule` importing `BillingModule` just for a test hook
 * — see `offers.module.ts`'s doc comment on the dependency direction.
 */
@ApiTags("offers")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("offers")
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  @Get("eligibility")
  @Roles("viewer")
  @ApiOperation({
    summary: "What this workspace may buy right now, and why not otherwise",
    description:
      "Every amount is read from the same catalogue `/billing/passes/checkout` quotes from — the " +
      "export dialog never hardcodes a price.",
    operationId: "getOffersEligibility",
  })
  @ApiOkResponse(
    zodResponse(offersEligibilityViewSchema, "Signup gift, ₹9 pass, week pass, top-up."),
  )
  async eligibility(@CurrentUser() principal: AuthPrincipal): Promise<OffersEligibilityView> {
    return this.offers.eligibility(principal.workspaceId);
  }

  @Get("passes")
  @Roles("viewer")
  @ApiOperation({
    summary: "Every pass this workspace has bought, newest first",
    description: "Backs the Subscription overview's pass status chips (expiry, credits left).",
    operationId: "listOffersPasses",
  })
  @ApiOkResponse(zodArrayResponse(passViewSchema, "Passes, newest first."))
  async passes(@CurrentUser() principal: AuthPrincipal): Promise<PassView[]> {
    return this.offers.listPasses(principal.workspaceId);
  }
}
