import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { ApiKeyDto, CreateApiKeyRequestDto, MintedApiKeyDto } from "./api-keys.dto.js";
import {
  ApiKeysService,
  type ApiKeyScope,
  type ApiKeyView,
  type MintedApiKeyView,
} from "./api-keys.service.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../../common/guards/index.js";
import { WorkspaceMemberGuard } from "../../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../../common/guards/index.js";

/**
 * `Settings → Developers → API keys` (B14 §1/§5).
 *
 * Web-session (JWT) only, same as `WebhooksController` — minting, rotating and
 * revoking a key is an account-management action, gated on `admin` because a
 * key is a standing credential into the workspace's data, one step short of
 * inviting a member.
 */
@ApiTags("developers")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("workspaces/:id/api-keys")
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Post()
  @Roles("admin")
  @ApiOperation({
    summary: "Mint a new API key",
    description: "The full key (`ak_live_<prefix>.<secret>`) is returned once, here, and never again.",
    operationId: "createApiKey",
  })
  @ApiOkResponse({ type: MintedApiKeyDto })
  @ApiPaymentRequiredResponse({ description: "`entitlement/upgrade_required` — Studio/Agency only." })
  async create(
    @CurrentUser() principal: AuthPrincipal,
    @Param("id") workspaceId: string,
    @Body() body: CreateApiKeyRequestDto,
  ): Promise<MintedApiKeyView> {
    return this.keys.create({
      workspaceId,
      userId: principal.userId,
      name: body.name,
      scopes: body.scopes as ApiKeyScope[],
      ...(body.expiresAt === undefined ? {} : { expiresAt: new Date(body.expiresAt) }),
    });
  }

  @Get()
  @Roles("viewer")
  @ApiOperation({ summary: "List a workspace's API keys (never the secret)", operationId: "listApiKeys" })
  @ApiOkResponse({ type: [ApiKeyDto] })
  async list(@Param("id") workspaceId: string): Promise<readonly ApiKeyView[]> {
    return this.keys.list(workspaceId);
  }

  @Post(":keyId/rotate")
  @Roles("admin")
  @ApiOperation({
    summary: "Rotate a key: mint a replacement, give the old one a 24h overlap window",
    operationId: "rotateApiKey",
  })
  @ApiOkResponse({ type: MintedApiKeyDto })
  @ApiNotFoundResponse({ description: "`public_api/key_not_found`." })
  async rotate(
    @CurrentUser() principal: AuthPrincipal,
    @Param("id") workspaceId: string,
    @Param("keyId") keyId: string,
  ): Promise<MintedApiKeyView> {
    return this.keys.rotate(workspaceId, principal.userId, keyId);
  }

  @Delete(":keyId")
  @Roles("admin")
  @ApiOperation({ summary: "Revoke an API key immediately", operationId: "revokeApiKey" })
  @ApiOkResponse({ type: ApiKeyDto })
  @ApiNotFoundResponse({ description: "`public_api/key_not_found`." })
  async revoke(
    @CurrentUser() principal: AuthPrincipal,
    @Param("id") workspaceId: string,
    @Param("keyId") keyId: string,
  ): Promise<ApiKeyView> {
    return this.keys.revoke(workspaceId, principal.userId, keyId);
  }
}
