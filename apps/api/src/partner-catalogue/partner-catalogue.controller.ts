import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { PARTNER_CATALOGUE_RATE_LIMITS } from "./partner-catalogue.constants.js";
import {
  createPartnerGrantSchema,
  CreatePartnerGrantDto,
  partnerGrantResultSchema,
  partnerSearchQuerySchema,
  PartnerSearchQuery,
  partnerSearchResultSchema,
} from "./partner-catalogue.dto.js";
import { PartnerCatalogueService } from "./partner-catalogue.service.js";
import { zodResponse } from "../auth/dto/openapi.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import {
  CurrentUser,
  CurrentWorkspace,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { zodDto } from "../common/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { PartnerGrantResultDto } from "./partner-catalogue.dto.js";
import type { PartnerSearchResult } from "./partner-catalogue.types.js";
import type { AuthPrincipal } from "../common/guards/index.js";

class PartnerSearchQueryDto extends zodDto(partnerSearchQuerySchema) {}
class CreatePartnerGrantBodyDto extends zodDto(createPartnerGrantSchema) {}

/**
 * The HTTP surface over `PartnerCatalogueService` (D04b2 scope §1) —
 * `PartnerCatalogueModule`'s own comment named this the missing piece after
 * D04b built the interface, grant lifecycle and refusal proofs but exposed
 * none of it.
 *
 * Every route 404s while `assets.partnerCatalogue` is off (2026-09-03
 * launch ruling: the feature must stay invisible, not merely refuse) —
 * `PartnerCatalogueService.enabled` is checked up front here, before the
 * service's own `assertEnabled()` would otherwise turn the same condition
 * into a 403. A 404 leaks nothing about whether the flag exists at all,
 * matching how other contract-gated surfaces in this codebase behave dark.
 */
@ApiTags("partner-catalogue")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`auth/not_a_member`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("partner-catalogue")
export class PartnerCatalogueController {
  constructor(
    private readonly catalogue: PartnerCatalogueService,
    private readonly audit: CommonAuditService,
  ) {}

  private assertFlagVisible(): void {
    if (!this.catalogue.enabled) {
      throw new NotFoundException({
        error: { code: "common/not_found", message: "Not found." },
      });
    }
  }

  @Get("search")
  @Roles("viewer")
  @UseGuards(RateLimitGuard)
  @RateLimit(PARTNER_CATALOGUE_RATE_LIMITS.search)
  @ApiOperation({
    summary: "Search the partner catalogue (SFX/music), 404 while assets.partnerCatalogue is off",
    operationId: "searchPartnerCatalogue",
  })
  @ApiOkResponse(zodResponse(partnerSearchResultSchema, "Partner catalogue search hits."))
  @ApiNotFoundResponse({ description: "The flag is off, or disabled for this workspace." })
  async search(@Query() query: PartnerSearchQueryDto): Promise<PartnerSearchResult> {
    this.assertFlagVisible();
    const filters: PartnerSearchQuery = query;
    return this.catalogue.search(filters.q, {
      ...(filters.kind === undefined ? {} : { kind: filters.kind }),
      ...(filters.minBpm === undefined ? {} : { minBpm: filters.minBpm }),
      ...(filters.maxBpm === undefined ? {} : { maxBpm: filters.maxBpm }),
      ...(filters.maxDurationMs === undefined ? {} : { maxDurationMs: filters.maxDurationMs }),
    });
  }

  @Post("grants")
  @HttpCode(HttpStatus.CREATED)
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(PARTNER_CATALOGUE_RATE_LIMITS.grant)
  @ApiOperation({
    summary: "Create a safelisting grant for a partner asset in a use context",
    description:
      "Refuses (404) while the flag is off, and refuses (per the adapter/D43 " +
      "predicate) when the asset cannot be cleared for the given use context. " +
      "Every grant is audit-logged.",
    operationId: "createPartnerCatalogueGrant",
  })
  @ApiOkResponse(
    zodResponse(partnerGrantResultSchema, "The created grant and its licence snapshot."),
  )
  @ApiNotFoundResponse({ description: "The flag is off, or disabled for this workspace." })
  async createGrant(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() user: AuthPrincipal,
    @Body() body: CreatePartnerGrantBodyDto,
  ): Promise<PartnerGrantResultDto> {
    this.assertFlagVisible();
    const input: CreatePartnerGrantDto = body;
    const result = await this.catalogue.grant({
      providerAssetId: input.providerAssetId,
      workspaceId,
      useContext: input.useContext,
    });
    await this.audit.record({
      action: "partner_catalogue.grant.created",
      resource: "asset_clearance_grant",
      resourceId: result.grantId,
      workspaceId,
      actorId: user.userId,
      actorKind: user.kind,
      data: { providerAssetId: input.providerAssetId, useContext: input.useContext },
    });
    return result;
  }

  @Delete("grants/:grantId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(PARTNER_CATALOGUE_RATE_LIMITS.revoke)
  @ApiOperation({
    summary: "Revoke a partner catalogue grant",
    operationId: "revokePartnerCatalogueGrant",
  })
  @ApiNotFoundResponse({ description: "The flag is off, or the grant does not exist." })
  async revokeGrant(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() user: AuthPrincipal,
    @Param("grantId") id: string,
  ): Promise<void> {
    this.assertFlagVisible();
    await this.catalogue.revoke(id);
    await this.audit.record({
      action: "partner_catalogue.grant.revoked",
      resource: "asset_clearance_grant",
      resourceId: id,
      workspaceId,
      actorId: user.userId,
      actorKind: user.kind,
      data: {},
    });
  }
}
