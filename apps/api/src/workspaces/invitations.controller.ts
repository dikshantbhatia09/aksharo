import {
  Controller,
  Delete,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { z } from "zod";

import { MembersService } from "./members.service.js";
import { invitationSchema } from "./workspaces.dto.js";
import { zodArrayResponse, zodResponse } from "../auth/dto/openapi.js";
import { CurrentUser, JwtAuthGuard, RolesGuard } from "../common/guards/index.js";
import { context } from "../users/users.controller.js";

import type { InvitationView } from "./members.service.js";
import type { $Enums } from "@prisma/client";
import type { Request } from "express";

const acceptedSchema = z.object({
  workspaceId: z.string(),
  role: z.enum(["owner", "admin", "editor", "viewer"]),
  /** Reminder that the caller's token still points at their previous workspace. */
  next: z.literal("POST /auth/token/exchange"),
});

/**
 * Invitations the caller has been sent — deliberately **not** under
 * `/workspaces/{id}`.
 *
 * An invitee is by definition not yet a member, and their access token is scoped
 * to whichever workspace they were already in, so `WorkspaceMemberGuard` would
 * refuse every one of these requests. Putting the routes on their own collection
 * keeps that guard's rule absolute ("every `/workspaces/:id` route requires
 * membership") instead of carving an exception into it.
 *
 * Authorisation is the caller's **verified** address matching the invitation's,
 * so the id in the link is a lookup key rather than a bearer secret.
 */
@ApiTags("invitations")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@Controller("invitations")
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvitationsController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @ApiOperation({
    summary: "Invitations waiting for the caller's address",
    description: "Empty until the address is verified: an invitation is an authorisation grant.",
    operationId: "listInvitations",
  })
  @ApiOkResponse(zodArrayResponse(invitationSchema, "Pending invitations, oldest first."))
  async list(@CurrentUser("userId") userId: string): Promise<InvitationView[]> {
    return this.members.invitationsFor(userId);
  }

  @Post(":id/accept")
  @ApiOperation({
    summary: "Accept an invitation",
    description:
      "Joins the workspace. The caller's session is untouched — exchange a token " +
      "for the returned `workspaceId` to start working in it.",
    operationId: "acceptInvitation",
  })
  @ApiOkResponse(zodResponse(acceptedSchema, "The workspace joined."))
  @ApiNotFoundResponse({ description: "`workspace/invitation_not_found`." })
  async accept(
    @Param("id") id: string,
    @CurrentUser("userId") userId: string,
    @Req() request: Request,
  ): Promise<{ workspaceId: string; role: $Enums.MembershipRole; next: string }> {
    const joined = await this.members.accept(id, userId, context(request));
    return { ...joined, next: "POST /auth/token/exchange" };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Decline an invitation", operationId: "declineInvitation" })
  @ApiNoContentResponse({ description: "The invitation was declined." })
  @ApiNotFoundResponse({ description: "`workspace/invitation_not_found`." })
  async decline(
    @Param("id") id: string,
    @CurrentUser("userId") userId: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.members.decline(id, userId, context(request));
  }
}
