import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  ExportDecisionResponseDto,
  ExportDownloadDto,
  ExportDto,
  ExportListDto,
  ExportListQueryDto,
  ExportRequestDto,
  ExportSourcesDto,
  ManifestCompleteRequestDto,
  ManifestCompleteResponseDto,
} from "./exports.dto.js";
import { ExportsService } from "./exports.service.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { LogAccess } from "../privacy/access-log.decorator.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";
import type { Export } from "@prisma/client";

/**
 * The exports surface (`03-architecture/07-api-and-contracts.md` §Jobs, passes,
 * exports): the decision engine's HTTP door, the browser-completion callback,
 * downloads and the list.
 *
 * `WorkspaceMemberGuard` re-checks membership on every route, exactly as
 * `transcripts` and `edg` do; `/exports/*` routes have no `:id` workspace
 * segment, so the guard falls back to the token's own workspace claim.
 */
@ApiTags("exports")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller()
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post("projects/:projectId/exports")
  @Roles("editor")
  @ApiOperation({
    summary: "Request an export: decides browser vs. cloud and issues a signed manifest or a job",
    description:
      "Always returns the chosen path with human-readable reasons for the export dialog. The " +
      "browser path returns a server-signed `RenderManifest` and never uploads bytes; the cloud " +
      "path enqueues `render.video` or `render.subtitle` and returns the job.",
    operationId: "requestExport",
  })
  @ApiOkResponse({ type: ExportDecisionResponseDto })
  @ApiConflictResponse({
    description: "`export/unsupported_in_browser`, `export/media_not_ready`, or similar.",
  })
  @ApiPaymentRequiredResponse({
    description: "`entitlement/upgrade_required` or `credits/insufficient`.",
  })
  async requestExport(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: ExportRequestDto,
  ): Promise<ExportDecisionResponseDto> {
    const result = await this.exports.requestExport({
      projectId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      kind: body.kind,
      outputKind: body.outputKind,
      preset: body.preset,
      ...(body.customWidth === undefined ? {} : { customWidth: body.customWidth }),
      ...(body.customHeight === undefined ? {} : { customHeight: body.customHeight }),
      script: body.script,
      mode: body.mode,
      dropFillers: body.dropFillers,
      ...(body.subtitle === undefined ? {} : { subtitle: body.subtitle }),
      ...(body.capabilities === undefined ? {} : { capabilities: body.capabilities }),
      options: body.options,
    });

    return {
      exportId: result.exportId,
      path: result.path,
      reasons: [...result.reasons],
      watermarked: result.watermarked,
      quote: result.quote,
      ...(result.manifest === undefined ? {} : { manifest: result.manifest }),
      ...(result.sources === undefined ? {} : { sources: result.sources }),
      ...(result.job === undefined ? {} : { job: result.job }),
    };
  }

  @Post("exports/manifests/:manifestId/complete")
  @Roles("editor")
  @ApiOperation({
    summary: "Close a browser export: single-use nonce, marks the export succeeded",
    description:
      "Consumes the manifest's signup gift / ₹9 pass when the decision cleared the watermark that " +
      "way, and emits a `publish_events` row for the streak experiment.",
    operationId: "completeExportManifest",
  })
  @ApiOkResponse({ type: ManifestCompleteResponseDto })
  @ApiNotFoundResponse({ description: "`export/manifest_not_found`." })
  @ApiConflictResponse({ description: "`export/manifest_already_consumed`." })
  @ApiGoneResponse({ description: "`export/manifest_expired`." })
  async completeManifest(
    @CurrentUser() principal: AuthPrincipal,
    @Param("manifestId") manifestId: string,
    @Body() body: ManifestCompleteRequestDto,
  ): Promise<ManifestCompleteResponseDto> {
    const result = await this.exports.completeManifest({
      manifestId,
      workspaceId: principal.workspaceId,
      sizeBytes: body.sizeBytes,
      durationMs: body.durationMs,
      checksum: body.checksum,
    });
    return {
      exportId: result.exportId,
      status: "succeeded",
      downloadAvailable: result.downloadAvailable,
    };
  }

  @Get("exports/manifests/:manifestId/sources")
  @Roles("editor")
  @ApiOperation({
    summary: "Reissue a browser manifest's source URLs once the originals expire",
    description:
      "Same ownership checks as the completion callback, minus the nonce claim: refreshing does " +
      "not consume anything.",
    operationId: "refreshExportManifestSources",
  })
  @ApiOkResponse({ type: ExportSourcesDto })
  @ApiNotFoundResponse({ description: "`export/manifest_not_found`." })
  @ApiConflictResponse({
    description: "`export/manifest_invalid` or `export/manifest_already_consumed`.",
  })
  @ApiGoneResponse({ description: "`export/manifest_expired`." })
  async refreshSources(
    @CurrentUser() principal: AuthPrincipal,
    @Param("manifestId") manifestId: string,
  ): Promise<ExportSourcesDto> {
    return this.exports.refreshSources(manifestId, principal.workspaceId);
  }

  @Get("projects/:projectId/exports")
  @Roles("viewer")
  @ApiOperation({ summary: "List a project's exports", operationId: "listProjectExports" })
  @ApiOkResponse({ type: ExportListDto })
  async list(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Query() query: ExportListQueryDto,
  ): Promise<ExportListDto> {
    const result = await this.exports.list({
      projectId,
      workspaceId: principal.workspaceId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { items: result.items.map(toDto), nextCursor: result.nextCursor };
  }

  @Get("exports/:exportId/download")
  @Roles("viewer")
  @HttpCode(HttpStatus.OK)
  @LogAccess("export")
  @ApiOperation({
    summary: "A short-lived signed download URL",
    description: "409 `export/not_ready` for a browser export — it never leaves the browser.",
    operationId: "getExportDownloadUrl",
  })
  @ApiOkResponse({ type: ExportDownloadDto })
  @ApiNotFoundResponse({ description: "`export/not_found`." })
  @ApiConflictResponse({ description: "`export/not_ready`." })
  async download(
    @CurrentUser() principal: AuthPrincipal,
    @Param("exportId") exportId: string,
  ): Promise<ExportDownloadDto> {
    return this.exports.downloadUrl(exportId, principal.workspaceId);
  }
}

function toDto(row: Export): ExportDto {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    kind: row.kind,
    preset: row.preset,
    watermarked: row.watermarked,
    resolution: row.resolution,
    durationMs: row.durationMs,
    sizeBytes: row.sizeBytes === null ? null : row.sizeBytes.toString(),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    downloads: row.downloads,
    createdAt: row.createdAt.toISOString(),
  };
}
