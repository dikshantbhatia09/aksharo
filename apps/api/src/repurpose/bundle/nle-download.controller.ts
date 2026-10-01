import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiExcludeEndpoint, ApiOperation, ApiTags } from "@nestjs/swagger";

import { type Env } from "@montaj/config";

import { NleDownloadDto, nleDownloadSchema } from "./nle-download.dto.js";
import { ClipNleDownloadService, type OpenedNleDownload } from "./nle-download.service.js";
import { contentDisposition, errorPage } from "./run-bundle.controller.js";
import { zodBody } from "../../auth/dto/openapi.js";
import { AppException } from "../../common/errors/error-codes.js";
import {
  CurrentUser,
  CurrentWorkspace,
  JwtAuthGuard,
  Public,
  Roles,
  RolesGuard,
} from "../../common/guards/index.js";
import { ENV } from "../../config/config.module.js";
import { WorkspaceMemberGuard } from "../../workspaces/workspace-member.guard.js";

import type { RunBundleDownload } from "./run-bundle.service.js";
import type { AuthPrincipal } from "../../common/guards/index.js";
import type { Response } from "express";

/**
 * "For your editing app" (2026-10-01): a single-use link to one clip's
 * editing package (clean cut, FCPXML, Premiere XML, SRT). Viewers and up, as
 * for "Download all": they can already download each of these files.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class ClipNleDownloadController {
  constructor(private readonly downloads: ClipNleDownloadService) {}

  @Post(":runId/clips/:clipId/nle-download")
  @Roles("viewer")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "A single-use link to a clip's files for an editing app",
    description:
      "`url` streams one ZIP once, within five minutes: the clip's clean cut in `shape`, an " +
      "FCPXML 1.9 timeline (Final Cut Pro, DaVinci Resolve) with every caption as a title, a " +
      "Final Cut Pro 7 XML timeline (Premiere Pro) and the captions as SRT, all on the clip's " +
      "own frame rate. 409 `repurpose/nle_not_ready` while that shape is not made yet.",
    operationId: "createRepurposeClipNleDownload",
  })
  @ApiBody(zodBody(nleDownloadSchema))
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() user: AuthPrincipal,
    @Param("runId") runId: string,
    @Param("clipId") clipId: string,
    @Body() body: NleDownloadDto,
  ): Promise<RunBundleDownload> {
    return this.downloads.createDownload(workspaceId, user.userId, runId, clipId, body.shape);
  }
}

/**
 * The ZIP itself, behind its single-use token: no bearer token (a browser
 * download cannot send one). A spent or expired link shows a short page back
 * to the app, as "Download all" does.
 */
@Controller("repurpose/nle-downloads")
export class PublicNleDownloadController {
  private readonly logger = new Logger(PublicNleDownloadController.name);

  constructor(
    private readonly downloads: ClipNleDownloadService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get(":token")
  @Public()
  @ApiExcludeEndpoint()
  async download(@Param("token") token: string, @Res() response: Response): Promise<void> {
    let opened: OpenedNleDownload;
    try {
      opened = await this.downloads.open(token);
    } catch (error) {
      const status =
        error instanceof AppException ? error.httpStatus : HttpStatus.INTERNAL_SERVER_ERROR;
      const message =
        error instanceof AppException ? error.message : "The download could not start. Try again.";
      if (!(error instanceof AppException)) {
        this.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          "a clip's editing download failed to start",
        );
      }
      response
        .status(status)
        .setHeader("cache-control", "no-store")
        .type("html")
        .send(errorPage(message, new URL("/repurpose", this.env.WEB_ORIGIN).toString()));
      return;
    }
    response.status(HttpStatus.OK);
    response.setHeader("content-type", "application/zip");
    response.setHeader("content-length", String(opened.totalBytes));
    response.setHeader("content-disposition", contentDisposition(opened.filename));
    response.setHeader("cache-control", "no-store");
    try {
      await pipeline(Readable.from(opened.stream), response);
    } catch {
      // The browser went away, or the clean cut could not be read part way:
      // the response is already cut short; the service logged which.
      response.destroy();
    }
  }
}
