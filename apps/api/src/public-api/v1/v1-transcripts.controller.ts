import { Body, Controller, Get, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";

import { ApiKeyRateLimitGuard } from "./api-key-rate-limit.guard.js";
import { IdempotencyService } from "./idempotency.service.js";
import { withIdempotency } from "./idempotent.helper.js";
import { V1TranscribeAcceptedDto, V1TranscribeRequestDto, V1TranscriptQueryDto } from "./v1.dto.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { ApiKeyGuard, ApiScopes, CurrentUser } from "../../common/guards/index.js";
import { EXPORT_MEDIA_TYPES } from "../../transcripts/transcript-export.js";
import { TranscriptsService } from "../../transcripts/transcripts.service.js";

import type { AuthPrincipal } from "../../common/guards/index.js";
import type { Request, Response } from "express";

@ApiTags("public")
@ApiSecurity("api-key")
@ApiUnauthorizedResponse({ description: "Missing or invalid `X-Api-Key`." })
@ApiForbiddenResponse({ description: "The key lacks the required scope." })
@UseGuards(ApiKeyGuard, ApiKeyRateLimitGuard)
@Controller("v1/projects/:projectId")
export class V1TranscriptsController {
  constructor(
    private readonly transcripts: TranscriptsService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: CommonAuditService,
  ) {}

  @Post("transcribe")
  @ApiScopes("projects_write")
  @ApiOperation({ summary: "Start transcription", operationId: "v1Transcribe" })
  @ApiOkResponse({ type: V1TranscribeAcceptedDto })
  async transcribe(
    @Req() request: Request,
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: V1TranscribeRequestDto,
  ): Promise<V1TranscribeAcceptedDto> {
    return withIdempotency(
      this.idempotency,
      request,
      principal.workspaceId,
      `POST /v1/projects/${projectId}/transcribe`,
      body,
      async () => {
        const accepted = await this.transcripts.transcribe({
          projectId,
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          ...(body.languages === undefined ? {} : { languages: body.languages }),
          ...(body.hints === undefined ? {} : { hints: body.hints }),
        });
        await this.audit.record({
          action: "public_api.transcript.requested",
          resource: "transcript",
          resourceId: accepted.transcriptId,
          actorId: principal.userId,
          actorKind: "api",
          workspaceId: principal.workspaceId,
          data: { projectId, jobId: accepted.jobId },
        });
        return { jobId: accepted.jobId, transcriptId: accepted.transcriptId, status: accepted.status };
      },
    );
  }

  @Get("transcript")
  @ApiScopes("transcripts_read")
  @ApiOperation({
    summary: "Download the transcript as json, srt or vtt",
    operationId: "v1GetTranscript",
  })
  @ApiOkResponse({ description: "The transcript file.", schema: { type: "string" } })
  async transcript(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Query() query: V1TranscriptQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.transcripts.export({
      projectId,
      workspaceId: principal.workspaceId,
      format: query.format,
    });
    response
      .status(HttpStatus.OK)
      .setHeader("Content-Type", EXPORT_MEDIA_TYPES[query.format])
      .setHeader("Content-Disposition", `attachment; filename="${file.filename}"`)
      .send(file.body);
  }
}
