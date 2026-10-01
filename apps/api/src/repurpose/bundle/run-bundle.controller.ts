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
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiExcludeEndpoint, ApiOperation, ApiTags } from "@nestjs/swagger";

import { type Env } from "@montaj/config";

import {
  RunDownloadDto,
  RunDownloadQueryDto,
  runDownloadSchema,
  selectedClipIds,
} from "./run-bundle.dto.js";
import {
  RunBundleService,
  type OpenedRunBundle,
  type RunBundleDownload,
  type RunBundleSummary,
} from "./run-bundle.service.js";
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

import type { AuthPrincipal } from "../../common/guards/index.js";
import type { Response } from "express";

/**
 * "Download all" (2026-10-01): what the ZIP of a run would hold, and a
 * single-use link to it. Anyone who can see the run's clips (viewers and up)
 * can already download each of its files, so the same members can take them
 * all at once.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class RunBundleController {
  constructor(private readonly bundles: RunBundleService) {}

  @Get(":runId/download")
  @Roles("viewer")
  @ApiOperation({
    summary: 'What a run\'s "Download all" ZIP holds, and its size',
    description:
      "Clips in it and still coming, videos, dubbed videos, images and text files, and the ZIP's " +
      "size with and without every shape's clean cut. `clipIds` (comma-separated) sums up only " +
      "those clips.",
    operationId: "getRepurposeRunDownload",
  })
  async summary(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
    @Query() query: RunDownloadQueryDto,
  ): Promise<RunBundleSummary> {
    return this.bundles.summary(workspaceId, runId, selectedClipIds(query.clipIds));
  }

  @Post(":runId/download")
  @Roles("viewer")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'A single-use link to a run\'s "Download all" ZIP',
    description:
      "`url` streams the ZIP once, within five minutes; `includeClean` adds every shape's " +
      "version without captions; `clipIds` takes only those clips. 409 " +
      "`repurpose/nothing_to_download` while no clip (of those) is finished.",
    operationId: "createRepurposeRunDownload",
  })
  @ApiBody(zodBody(runDownloadSchema))
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() user: AuthPrincipal,
    @Param("runId") runId: string,
    @Body() body: RunDownloadDto,
  ): Promise<RunBundleDownload> {
    return this.bundles.createDownload(workspaceId, user.userId, runId, body);
  }
}

/**
 * The ZIP itself, behind its single-use token: no bearer token (a browser
 * download cannot send one). A browser that follows a spent or expired link
 * is shown a short page that sends it back, rather than an error body.
 */
@Controller("repurpose/downloads")
export class PublicRunDownloadController {
  private readonly logger = new Logger(PublicRunDownloadController.name);

  constructor(
    private readonly bundles: RunBundleService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get(":token")
  @Public()
  @ApiExcludeEndpoint()
  async download(@Param("token") token: string, @Res() response: Response): Promise<void> {
    let bundle: OpenedRunBundle;
    try {
      bundle = await this.bundles.open(token);
    } catch (error) {
      const status =
        error instanceof AppException ? error.httpStatus : HttpStatus.INTERNAL_SERVER_ERROR;
      const message =
        error instanceof AppException ? error.message : "The download could not start. Try again.";
      if (!(error instanceof AppException)) {
        this.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          "a run download failed to start",
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
    response.setHeader("content-length", String(bundle.totalBytes));
    response.setHeader("content-disposition", contentDisposition(bundle.filename));
    response.setHeader("cache-control", "no-store");
    try {
      await pipeline(Readable.from(bundle.stream), response);
    } catch {
      // The browser went away, or a file could not be read part way: the
      // response is already cut short; the service logged which.
      response.destroy();
    } finally {
      bundle.release();
    }
  }
}

/** `attachment` with an ASCII fallback name and the real one (RFC 6266 / 5987). */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${String(char.charCodeAt(0))};`);
}

export function errorPage(message: string, backUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Download</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141217;color:#f1ece6;font:16px/1.5 system-ui,sans-serif}main{max-width:28rem;padding:24px}a{color:#f0508a}</style></head>
<body><main><h1 style="font-size:20px">The download did not start</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(backUrl)}">Back to your videos</a></p></main></body></html>`;
}
