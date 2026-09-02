import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  OwnershipTransferService,
  type TransferOwnershipResult,
} from "./ownership-transfer.service.js";
import {
  TransferOwnershipDto,
  transferOwnershipResponseSchema,
  transferOwnershipSchema,
} from "./teams.dto.js";
import { zodBody, zodResponse } from "../../auth/dto/openapi.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../../common/guards/index.js";
import { context } from "../../users/users.controller.js";
import { WorkspaceMemberGuard } from "../workspace-member.guard.js";

import type { AuthPrincipal } from "../../common/guards/index.js";
import type { Request } from "express";

/**
 * `POST /workspaces/{id}/transfer-ownership` (orchestrator addendum, after
 * A05). Registered under the same `/workspaces` prefix as `WorkspacesController`
 * and wearing the same three guards every `:id` route there does —
 * `test/workspace-guard.e2e-spec.ts` enumerates the whole route table, not one
 * controller's, so this has to hold up under that scan too.
 */
@ApiTags("workspaces")
@Controller("workspaces")
export class OwnershipTransferController {
  constructor(private readonly transfer: OwnershipTransferService) {}

  @Post(":id/transfer-ownership")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("owner")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Transfer workspace ownership",
    description:
      "Owner only. The first call (no confirmToken) mints a 10-minute " +
      "confirmation token and mails it to the current owner; the second call, " +
      "with that token, executes the transfer. Sessions are unaffected.",
    operationId: "transferWorkspaceOwnership",
  })
  @ApiBody(zodBody(transferOwnershipSchema))
  @ApiOkResponse(
    zodResponse(transferOwnershipResponseSchema, "Confirmation sent, or transfer applied."),
  )
  @HttpCode(HttpStatus.OK)
  async transferOwnership(
    @Param("id") workspaceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: TransferOwnershipDto,
    @Req() request: Request,
  ): Promise<TransferOwnershipResult> {
    return this.transfer.transfer(
      workspaceId,
      principal.userId,
      body.toMembershipId,
      body.confirmToken,
      context(request),
    );
  }
}
