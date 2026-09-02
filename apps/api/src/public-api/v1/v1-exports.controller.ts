import { Body, Controller, Get, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";

import { ApiKeyRateLimitGuard } from "./api-key-rate-limit.guard.js";
import { IdempotencyService } from "./idempotency.service.js";
import { withIdempotency } from "./idempotent.helper.js";
import { V1CreateExportRequestDto, V1ExportAcceptedDto, V1ExportDto } from "./v1.dto.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { ApiKeyGuard, ApiScopes, CurrentUser } from "../../common/guards/index.js";
import { AppException, ERROR_CODES, PrismaService } from "../../common/index.js";
import { ExportsService } from "../../exports/exports.service.js";

import type { AuthPrincipal } from "../../common/guards/index.js";
import type { Request } from "express";

/**
 * `/v1/exports` (B14 §2). Always the **cloud** render path — a signed browser
 * manifest is meaningless to a server-to-server caller with no browser to hand
 * it to — and watermark rules apply exactly as they do for a web-session export
 * (`ExportsService.requestExport` does not know or care which guard let the
 * caller in).
 */
@ApiTags("public")
@ApiSecurity("api-key")
@ApiUnauthorizedResponse({ description: "Missing or invalid `X-Api-Key`." })
@ApiForbiddenResponse({ description: "The key lacks the required scope." })
@UseGuards(ApiKeyGuard, ApiKeyRateLimitGuard)
@Controller("v1")
export class V1ExportsController {
  constructor(
    private readonly exports: ExportsService,
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: CommonAuditService,
  ) {}

  @Post("projects/:projectId/exports")
  @ApiScopes("exports_write")
  @ApiOperation({ summary: "Request an export (cloud path)", operationId: "v1CreateExport" })
  @ApiOkResponse({ type: V1ExportAcceptedDto })
  async create(
    @Req() request: Request,
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: V1CreateExportRequestDto,
  ): Promise<V1ExportAcceptedDto> {
    return withIdempotency(
      this.idempotency,
      request,
      principal.workspaceId,
      `POST /v1/projects/${projectId}/exports`,
      body,
      async () => {
        const result = await this.exports.requestExport({
          projectId,
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          kind: "video",
          outputKind: "video",
          preset: body.preset,
          script: "roman",
          mode: "cloud",
          dropFillers: false,
          options: {
            ...(body.styleId === undefined ? {} : { brandAssetId: body.styleId }),
            watermarkPosition: "bottom-right",
            watermarkOpacity: 1,
          },
        });
        await this.audit.record({
          action: "public_api.export.requested",
          resource: "export",
          resourceId: result.exportId,
          actorId: principal.userId,
          actorKind: "api",
          workspaceId: principal.workspaceId,
          data: { projectId, preset: body.preset },
        });
        return {
          exportId: result.exportId,
          status: result.job?.status ?? "queued",
          ...(result.job === undefined ? {} : { jobId: result.job.jobId }),
        };
      },
    );
  }

  @Get("exports/:exportId")
  @ApiScopes("exports_write")
  @ApiOperation({ summary: "Fetch an export's status and (once ready) its download URL", operationId: "v1GetExport" })
  @ApiOkResponse({ type: V1ExportDto })
  async get(
    @CurrentUser() principal: AuthPrincipal,
    @Param("exportId") exportId: string,
  ): Promise<V1ExportDto> {
    const row = await this.prisma.export.findFirst({
      where: { id: exportId, workspaceId: principal.workspaceId },
    });
    if (row === null) {
      throw new AppException(ERROR_CODES.notFound, "No such export.", HttpStatus.NOT_FOUND);
    }

    let downloadUrl: string | null = null;
    if (row.status === "succeeded" && row.storageKey !== null) {
      const signed = await this.exports.downloadUrl(exportId, principal.workspaceId);
      downloadUrl = signed.url;
    }

    return {
      id: row.id,
      projectId: row.projectId,
      status: row.status,
      downloadUrl,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
