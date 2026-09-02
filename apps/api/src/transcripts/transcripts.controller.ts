import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { EXPORT_MEDIA_TYPES } from "./transcript-export.js";
import {
  ExportQueryDto,
  RetranscribeRequestDto,
  TranscribeAcceptedDto,
  TranscribeRequestDto,
  TranscriptChunkPageDto,
  TranscriptQueryDto,
} from "./transcripts.dto.js";
import { TranscriptsService } from "./transcripts.service.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";
import type { Response } from "express";

/**
 * The transcript surface: start one, read one, export one, redo one.
 *
 * **Who may call.** `@Roles("editor")` admits editor, admin and owner — starting
 * a transcription spends the workspace's credits, so a viewer may read the result
 * and not commission it. Reads are `@Roles("viewer")`.
 *
 * **Which workspace.** The `ws` claim, always. The service resolves
 * `(projectId, workspaceId)` and a project belonging to somebody else is a 404,
 * not a 403 (THREAT-MODEL T4, T5).
 *
 * `WorkspaceMemberGuard` re-reads the membership so a removal or a demotion bites
 * on the next request rather than at the end of the fifteen-minute token — the
 * same guard `/workspaces/:id/*` wears, and the reason these routes carry it too.
 */
@ApiTags("transcripts")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiNotFoundResponse({ description: "`common/not_found`, or `transcript/not_found`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("projects/:projectId")
export class TranscriptsController {
  constructor(private readonly transcripts: TranscriptsService) {}

  @Post("transcribe")
  @Roles("editor")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Transcribe the project's primary media",
    description:
      "Quotes the job from the probed media duration (1 credit a minute, rounded up to " +
      "0.1 of a minute), holds the credits and enqueues `ai.transcribe`. The transcript " +
      "and the editing document are written when the worker's completion arrives; watch " +
      "`job.completed` on the project's realtime room, or poll `GET /jobs/{id}`. " +
      "Diarisation is free — the transcription rate includes it.",
    operationId: "transcribeProject",
  })
  @ApiOkResponse({ type: TranscribeAcceptedDto, description: "Accepted and queued." })
  @ApiConflictResponse({ description: "`transcript/media_not_ready`." })
  @ApiPaymentRequiredResponse({ description: "`credits/insufficient`." })
  async transcribe(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: TranscribeRequestDto,
  ): Promise<TranscribeAcceptedDto> {
    return this.transcripts.transcribe({
      projectId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      languages: body.languages,
      hints: body.hints,
      ...(body.diarise === undefined ? {} : { diarise: body.diarise }),
      ...(body.captions === undefined ? {} : { captions: body.captions }),
    });
  }

  @Post("transcript/retranscribe")
  @Roles("editor")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Transcribe the media again",
    description:
      "Refused with `transcript/has_edits` when the editing document has moved past the " +
      "revision the first transcription created: a new transcription mints new word ids, " +
      "and edited captions are addressed by the old ones. Send `force: true` to proceed.",
    operationId: "retranscribeProject",
  })
  @ApiOkResponse({ type: TranscribeAcceptedDto })
  @ApiConflictResponse({ description: "`transcript/has_edits` or `transcript/media_not_ready`." })
  async retranscribe(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: RetranscribeRequestDto,
  ): Promise<TranscribeAcceptedDto> {
    return this.transcripts.retranscribe({
      projectId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      languages: body.languages,
      hints: body.hints,
      force: body.force,
      ...(body.diarise === undefined ? {} : { diarise: body.diarise }),
      ...(body.captions === undefined ? {} : { captions: body.captions }),
    });
  }

  @Get("transcript")
  @Roles("viewer")
  @ApiOperation({
    summary: "The transcript manifest and one page of chunks",
    description:
      "Chunks are paged because one 10-minute chunk is roughly 1 500 words: a long " +
      "recording is megabytes and an editor opens on the first screenful. The cursor is " +
      "the previous page's last `chunkIdx`.",
    operationId: "getProjectTranscript",
  })
  @ApiOkResponse({ type: TranscriptChunkPageDto })
  async transcript(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Query() query: TranscriptQueryDto,
  ): Promise<TranscriptChunkPageDto> {
    const page = await this.transcripts.chunks({
      projectId,
      workspaceId: principal.workspaceId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.revision === undefined ? {} : { revision: query.revision }),
      ...(query.script === undefined ? {} : { script: query.script }),
    });
    return {
      transcript: page.transcript as TranscriptChunkPageDto["transcript"],
      chunks: [...page.chunks],
      nextCursor: page.nextCursor,
    };
  }

  @Get("transcript/export")
  @Roles("viewer")
  @ApiProduces("application/json", "application/x-subrip", "text/vtt", "text/plain")
  @ApiOperation({
    summary: "Download the transcript",
    description:
      "**Source time**: cues are where the words were spoken in the uploaded media. Once " +
      "a project has cuts that is no longer the finished video's clock — output-time " +
      "exports are A21's. Cues come from the editing document's captions when it has " +
      "them, so an export reflects what the user edited.",
    operationId: "exportProjectTranscript",
  })
  @ApiOkResponse({ description: "The transcript file.", schema: { type: "string" } })
  async export(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Query() query: ExportQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.transcripts.export({
      projectId,
      workspaceId: principal.workspaceId,
      format: query.format,
      ...(query.revision === undefined ? {} : { revision: query.revision }),
      ...(query.dropFillers === undefined ? {} : { dropFillers: query.dropFillers }),
      ...(query.script === undefined ? {} : { script: query.script }),
    });

    response
      .status(HttpStatus.OK)
      .setHeader("Content-Type", EXPORT_MEDIA_TYPES[query.format])
      // `attachment`: the browser saves it rather than rendering somebody's
      // transcript as HTML in the API's own origin.
      .setHeader("Content-Disposition", `attachment; filename="${file.filename}"`)
      .send(file.body);
  }
}
