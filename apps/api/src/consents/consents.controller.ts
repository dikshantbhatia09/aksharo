import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { consentsResponseSchema, SetConsentDto, setConsentSchema } from "./consents.dto.js";
import { ConsentsService } from "./consents.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  AllowBridgeToken,
  CurrentUser,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  RolesGuard,
} from "../common/guards/index.js";
import { ACCOUNT_RATE_LIMITS } from "../users/account.constants.js";
import { context } from "../users/users.controller.js";

import type { ConsentsView } from "./consents.service.js";
import type { AuthPrincipal } from "../common/guards/index.js";
import type { Request } from "express";

/**
 * Per-purpose consent (07 §Privacy & rights, D61).
 *
 * Both routes act on the caller and on nobody else. The workspace stamped onto a
 * record is the one in the access token, so a consent given while working for one
 * client is attributable to that workspace.
 */
@ApiTags("consents")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@Controller("consents")
@UseGuards(JwtAuthGuard, RolesGuard, RateLimitGuard)
export class ConsentsController {
  constructor(private readonly consents: ConsentsService) {}

  @Get()
  @AllowBridgeToken()
  @ApiOperation({
    summary: "The caller's current answer for every purpose",
    description:
      "`reconsentRequired` is true when a purpose was last answered against an " +
      "older privacy notice — the choice has to be asked again (D61, Rule 3). " +
      "`@AllowBridgeToken()` (M04): the local bridge process reads this on " +
      "startup and on its periodic refresh to know whether the `telemetry` " +
      "purpose is granted, the same read a browser session makes — it is a " +
      "read of the caller's own consent state, not an action on anyone else's.",
    operationId: "getConsents",
  })
  @ApiOkResponse(zodResponse(consentsResponseSchema, "Current consent state."))
  async list(@CurrentUser("userId") userId: string): Promise<ConsentsView> {
    return this.consents.current(userId);
  }

  @Post()
  @RateLimit(ACCOUNT_RATE_LIMITS.consentUser)
  @ApiOperation({
    summary: "Grant or withdraw one purpose",
    description:
      "Appends a `consent_records` row with the caller's address, user agent and " +
      "the current notice version. A refusal is recorded as a row, not as an " +
      "absent row: the record has to show what was asked as well as what was agreed.",
    operationId: "setConsent",
  })
  @ApiBody(zodBody(setConsentSchema))
  @ApiOkResponse(zodResponse(consentsResponseSchema, "Consent state after the change."))
  @ApiTooManyRequestsResponse({ description: "`common/rate_limited`." })
  async set(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: SetConsentDto,
    @Req() request: Request,
  ): Promise<ConsentsView> {
    return this.consents.set(
      principal.userId,
      principal.workspaceId,
      body.purpose,
      body.granted,
      context(request),
    );
  }
}
