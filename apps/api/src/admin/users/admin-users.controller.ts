import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
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
  AdminSearchQueryDto,
  AdminUserDetailDto,
  AdminUserSummaryDto,
  AdminWorkspaceDetailDto,
  AdminWorkspaceSummaryDto,
} from "./admin-users.dto.js";
import { AdminUsersService } from "./admin-users.service.js";
import { AdminGuard } from "../admin.guard.js";

/**
 * Read-only cross-tenant search/detail (B13 scope §2). No `@AdminRoles(...)`
 * restriction — every admin role, including `support`, may view (the brief's
 * own e2e case: "support role can view but not refund").
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "Requires an admin session (POST /admin/auth/step-up)." })
@UseGuards(AdminGuard)
@Controller("admin")
export class AdminUsersController {
  constructor(private readonly admin: AdminUsersService) {}

  @Get("users")
  @ApiOperation({ summary: "Search users by email/name", operationId: "adminSearchUsers" })
  @ApiOkResponse({ type: [AdminUserSummaryDto] })
  async searchUsers(@Query() query: AdminSearchQueryDto) {
    return this.admin.searchUsers(query);
  }

  @Get("users/:id")
  @ApiOperation({
    summary: "User detail: memberships, devices, admin roles",
    operationId: "adminUserDetail",
  })
  @ApiOkResponse({ type: AdminUserDetailDto })
  @ApiNotFoundResponse({ description: "`common/not_found`." })
  async userDetail(@Param("id") id: string): Promise<AdminUserDetailDto> {
    return this.admin.userDetail(id);
  }

  @Get("workspaces")
  @ApiOperation({ summary: "Search workspaces by name/slug", operationId: "adminSearchWorkspaces" })
  @ApiOkResponse({ type: [AdminWorkspaceSummaryDto] })
  async searchWorkspaces(@Query() query: AdminSearchQueryDto) {
    return this.admin.searchWorkspaces(query);
  }

  @Get("workspaces/:id")
  @ApiOperation({
    summary: "Workspace detail: owner, plan/subscription, credit account",
    operationId: "adminWorkspaceDetail",
  })
  @ApiOkResponse({ type: AdminWorkspaceDetailDto })
  @ApiNotFoundResponse({ description: "`common/not_found`." })
  async workspaceDetail(@Param("id") id: string): Promise<AdminWorkspaceDetailDto> {
    return this.admin.workspaceDetail(id);
  }
}
