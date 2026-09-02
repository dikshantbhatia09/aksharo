import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";

import { EntitlementService } from "./entitlement.service.js";
import { MembersService } from "./members.service.js";
import { WorkspaceMemberGuard } from "./workspace-member.guard.js";
import { WORKSPACE_RATE_LIMITS } from "./workspaces.constants.js";
import {
  ChangeRoleDto,
  changeRoleSchema,
  CreateWorkspaceDto,
  createWorkspaceSchema,
  entitlementSchema,
  InviteMemberDto,
  inviteMemberSchema,
  memberSchema,
  TaxProfileDto,
  taxProfileSchema,
  UpdateWorkspaceDto,
  updateWorkspaceSchema,
  workspaceSchema,
} from "./workspaces.dto.js";
import { WorkspacesService } from "./workspaces.service.js";
import { zodArrayResponse, zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  CurrentUser,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { context } from "../users/users.controller.js";

import type { EntitlementView } from "./entitlement.service.js";
import type { MemberView } from "./members.service.js";
import type { WorkspaceView } from "./workspaces.service.js";
import type { AuthPrincipal } from "../common/guards/index.js";
import type { $Enums } from "@prisma/client";
import type { Request } from "express";

/**
 * Workspaces, their tax profile, their members and their entitlement.
 *
 * **Every route with an `:id` wears `WorkspaceMemberGuard`** (THREAT-MODEL T4).
 * The guard proves that the id in the path is the `ws` claim of the access token
 * and that an active membership still exists, and it replaces the principal's
 * role with the one in the database — so `RolesGuard`, which runs after it,
 * judges the live role rather than the one minted up to fifteen minutes ago. The
 * guard list is declared per route rather than on the class because the two
 * collection routes (`GET /workspaces`, `POST /workspaces`) have no `:id` and
 * genuinely must not require membership of anything.
 *
 * `test/workspace-guard.e2e-spec.ts` enumerates this controller's route table
 * from the Nest router and fails if any `:id` route is missing the guard, so the
 * rule cannot rot as routes are added.
 */
@ApiTags("workspaces")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@Controller("workspaces")
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly members: MembersService,
    private readonly entitlements: EntitlementService,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiOperation({
    summary: "The workspaces the caller belongs to",
    description:
      "Not scoped to the token's `ws` claim: this is the list a workspace " +
      "switcher renders, and switching goes through `POST /auth/token/exchange`.",
    operationId: "listWorkspaces",
  })
  @ApiOkResponse(zodArrayResponse(workspaceSchema, "The caller's workspaces, oldest first."))
  async list(@CurrentUser("userId") userId: string): Promise<WorkspaceView[]> {
    return this.workspaces.listForUser(userId);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard, RateLimitGuard)
  @RateLimit(WORKSPACE_RATE_LIMITS.createUser)
  @ApiOperation({
    summary: "Create a team or agency workspace",
    description:
      "The caller becomes its owner. Region and currency follow their declared " +
      "jurisdiction and the billing country starts **unconfirmed** — a guess until " +
      "somebody sets a tax profile on it.",
    operationId: "createWorkspace",
  })
  @ApiBody(zodBody(createWorkspaceSchema))
  @ApiCreatedResponse(zodResponse(workspaceSchema, "The new workspace."))
  @ApiConflictResponse({ description: "`workspace/slug_taken`." })
  async create(
    @CurrentUser("userId") userId: string,
    @Body() body: CreateWorkspaceDto,
    @Req() request: Request,
  ): Promise<WorkspaceView> {
    return this.workspaces.create(userId, body, context(request));
  }

  @Get(":id")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @ApiOperation({ summary: "One workspace", operationId: "getWorkspace" })
  @ApiOkResponse(zodResponse(workspaceSchema, "The workspace."))
  @ApiForbiddenResponse({ description: "`auth/not_a_member`." })
  async get(
    @Param("id") id: string,
    @CurrentUser("role") role: $Enums.MembershipRole,
  ): Promise<WorkspaceView> {
    return this.workspaces.get(id, role);
  }

  @Patch(":id")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiOperation({
    summary: "Rename a workspace or change its settings",
    description: "`settings` is merged, not replaced, so a partial patch keeps the rest.",
    operationId: "updateWorkspace",
  })
  @ApiBody(zodBody(updateWorkspaceSchema))
  @ApiOkResponse(zodResponse(workspaceSchema, "The updated workspace."))
  @ApiForbiddenResponse({ description: "`auth/not_a_member` or `common/forbidden`." })
  @ApiConflictResponse({ description: "`workspace/slug_taken`." })
  async update(
    @Param("id") id: string,
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: UpdateWorkspaceDto,
    @Req() request: Request,
  ): Promise<WorkspaceView> {
    return this.workspaces.update(id, principal.userId, principal.role, body, context(request));
  }

  @Put(":id/tax-profile")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("owner")
  @ApiOperation({
    summary: "Set the billing country, State and GSTIN",
    description:
      "India requires a validated GST State code (D41, Circular 242/36/2024-GST); " +
      "a GSTIN is optional but is checked against its base-36 check digit and must " +
      "name the same State. Currency follows the country (IN → INR, otherwise USD) " +
      "and is locked once a subscription exists. Confirming a profile stamps " +
      "`billingCountryConfirmedAt`, which is what B01 requires before a checkout.",
    operationId: "setWorkspaceTaxProfile",
  })
  @ApiBody(zodBody(taxProfileSchema))
  @ApiOkResponse(zodResponse(workspaceSchema, "The workspace with its tax profile."))
  @ApiUnprocessableEntityResponse({ description: "`workspace/tax_profile_invalid`." })
  @ApiConflictResponse({ description: "`workspace/tax_profile_locked`." })
  async setTaxProfile(
    @Param("id") id: string,
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: TaxProfileDto,
    @Req() request: Request,
  ): Promise<WorkspaceView> {
    return this.workspaces.setTaxProfile(
      id,
      principal.userId,
      principal.role,
      body,
      context(request),
    );
  }

  @Delete(":id")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("owner")
  @ApiOperation({
    summary: "Delete a workspace",
    description:
      "Soft delete; every session scoped to it is revoked. Refused when it is the " +
      "caller's only workspace — `DELETE /me` is how a person leaves altogether.",
    operationId: "deleteWorkspace",
  })
  @ApiOkResponse({ description: "The workspace was deleted." })
  @ApiConflictResponse({ description: "`workspace/last_remaining`." })
  async remove(
    @Param("id") id: string,
    @CurrentUser("userId") userId: string,
    @Req() request: Request,
  ): Promise<{ id: string; deletedAt: string }> {
    return this.workspaces.remove(id, userId, context(request));
  }

  @Get(":id/entitlement")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @ApiOperation({
    summary: "What this workspace may do",
    description:
      "Cached 60 seconds (07 §Workspaces). **Stub:** the Free plan's entitlements " +
      "for every workspace; B02 computes plan + seats + passes + flags.",
    operationId: "getWorkspaceEntitlement",
  })
  @ApiOkResponse(zodResponse(entitlementSchema, "The workspace's entitlement."))
  async entitlement(@Param("id") id: string): Promise<EntitlementView> {
    return this.entitlements.forWorkspace(id);
  }

  // --- Members -------------------------------------------------------------

  @Get(":id/members")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @ApiOperation({
    summary: "The workspace's members and outstanding invitations",
    operationId: "listWorkspaceMembers",
  })
  @ApiOkResponse(zodArrayResponse(memberSchema, "Members, the owner first."))
  async listMembers(@Param("id") id: string): Promise<MemberView[]> {
    return this.members.list(id);
  }

  @Post(":id/members")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard, RateLimitGuard)
  @Roles("admin")
  @RateLimit(WORKSPACE_RATE_LIMITS.inviteUser)
  @ApiOperation({
    summary: "Invite an address to the workspace",
    description:
      "Creates a pending `memberships` row and sends the invitation. The row " +
      "becomes a membership only when that person accepts it themselves, from a " +
      "verified address.",
    operationId: "inviteWorkspaceMember",
  })
  @ApiBody(zodBody(inviteMemberSchema))
  @ApiCreatedResponse(zodResponse(memberSchema, "The pending invitation."))
  @ApiConflictResponse({ description: "`workspace/member_already_present`." })
  async invite(
    @Param("id") id: string,
    @CurrentUser("userId") userId: string,
    @Body() body: InviteMemberDto,
    @Req() request: Request,
  ): Promise<MemberView> {
    return this.members.invite(id, userId, body, context(request));
  }

  @Patch(":id/members/:membershipId")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiOperation({
    summary: "Change a member's role",
    description: "The owner's role is immutable, and nobody may grant a role above their own.",
    operationId: "changeWorkspaceMemberRole",
  })
  @ApiBody(zodBody(changeRoleSchema))
  @ApiOkResponse(zodResponse(memberSchema, "The updated member."))
  @ApiNotFoundResponse({ description: "`workspace/member_not_found`." })
  @ApiConflictResponse({ description: "`workspace/owner_immutable`." })
  async changeRole(
    @Param("id") id: string,
    @Param("membershipId") membershipId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: ChangeRoleDto,
    @Req() request: Request,
  ): Promise<MemberView> {
    return this.members.changeRole(
      id,
      membershipId,
      { id: principal.userId, role: principal.role },
      body,
      context(request),
    );
  }

  @Delete(":id/members/:membershipId")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Remove a member or withdraw an invitation",
    description: "Every session that member holds in this workspace is revoked at once.",
    operationId: "removeWorkspaceMember",
  })
  @ApiOkResponse({ description: "The member was removed." })
  @ApiNotFoundResponse({ description: "`workspace/member_not_found`." })
  @ApiConflictResponse({ description: "`workspace/owner_immutable`." })
  async removeMember(
    @Param("id") id: string,
    @Param("membershipId") membershipId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Req() request: Request,
  ): Promise<{ id: string; status: $Enums.MembershipStatus }> {
    return this.members.remove(
      id,
      membershipId,
      { id: principal.userId, role: principal.role },
      context(request),
    );
  }
}
