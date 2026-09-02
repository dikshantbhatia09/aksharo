import { Body, Controller, Delete, Get, Header, Param, Post, Res, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";

import { BundledFontsService } from "./bundled-fonts.service.js";
import { BUNDLED_FONT_CACHE_SECONDS, FONT_RATE_LIMITS } from "./fonts.constants.js";
import {
  CompleteFontUploadDto,
  completeFontUploadSchema,
  fontCatalogueSchema,
  fontManifestViewSchema,
  fontUploadTicketSchema,
  fontUrlsSchema,
  InitFontUploadDto,
  initFontUploadSchema,
  workspaceFontSchema,
} from "./fonts.dto.js";
import { FontsService } from "./fonts.service.js";
import { zodArrayResponse, zodBody, zodResponse } from "../auth/dto/openapi.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import {
  CurrentUser,
  CurrentWorkspace,
  JwtAuthGuard,
  Public,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { FontUploadTicket, FontUrls, WorkspaceFontView } from "./fonts.service.js";
import type { Response } from "express";

/**
 * The bundled catalogue — the same for every workspace, so no `:id` in sight.
 *
 * `GET /fonts/manifest` and `GET /styles/fonts/catalog` need a session, because
 * they are product surface. `GET /fonts/pack/{file}` does not: it serves OFL and
 * Apache font bytes whose licences expressly permit redistribution, they are
 * identical for every tenant, and a CSS `@font-face` cannot carry a bearer
 * token. Making it public is what lets the editor's font picker preview a family
 * in its own typeface.
 */
@ApiTags("fonts")
@Controller()
export class BundledFontsController {
  constructor(private readonly bundled: BundledFontsService) {}

  @Get("fonts/manifest")
  @ApiBearerAuth("access-token")
  @ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: "The bundled font catalogue",
    description:
      "Every open-licence face that ships with the product: family, weight, the " +
      "scripts it covers, its licence, its SHA-256 and the URLs its bytes are at. " +
      "The renderer registers these into `FontRegistry`; the same document is " +
      "baked into the cloud render image as `fonts.json`.",
    operationId: "getBundledFontManifest",
  })
  @ApiOkResponse(zodResponse(fontManifestViewSchema, "The bundled pack manifest."))
  async manifest(): Promise<unknown> {
    return this.bundled.getManifest();
  }

  @Get("styles/fonts/catalog")
  @ApiBearerAuth("access-token")
  @ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: "The font picker's curated list",
    description:
      "The bundled families with their weights, script coverage tags and " +
      "licences, plus the 22 scheduled languages and the script each needs. " +
      "Built from the shipped manifest, so a family cannot be offered without " +
      "its bytes being in the image.",
    operationId: "getFontCatalogue",
  })
  @ApiOkResponse(zodResponse(fontCatalogueSchema, "Families and languages."))
  async catalogue(): Promise<unknown> {
    return this.bundled.getCatalogue();
  }

  @Get("fonts/pack/:file")
  @Public()
  @Header("cache-control", `public, max-age=${String(BUNDLED_FONT_CACHE_SECONDS)}, immutable`)
  @ApiExcludeEndpoint()
  async file(@Param("file") file: string, @Res() response: Response): Promise<void> {
    const { bytes, contentType } = await this.bundled.readFile(file);
    response.setHeader("content-type", contentType);
    response.setHeader("content-length", String(bytes.byteLength));
    response.end(bytes);
  }
}

/**
 * A workspace's own fonts.
 *
 * Guard stack and role ladder are the ones `WorkspacesController` documents:
 * `WorkspaceMemberGuard` proves the `:id` in the path is the token's `ws` claim
 * and that the membership still exists, then `RolesGuard` applies the route's
 * `@Roles`. Uploading is an editor's job; deleting is an admin's, because a
 * font other people's projects draw with is shared state.
 */
@ApiTags("fonts")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`auth/not_a_member` or `common/forbidden`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("workspaces/:id/fonts")
export class WorkspaceFontsController {
  constructor(
    private readonly fonts: FontsService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "The workspace's custom fonts",
    description: "Every uploaded font and its licence-warranty record.",
    operationId: "listWorkspaceFonts",
  })
  @ApiOkResponse(zodArrayResponse(workspaceFontSchema, "The workspace's fonts."))
  async list(@CurrentWorkspace() workspaceId: string): Promise<WorkspaceFontView[]> {
    return this.fonts.list(workspaceId);
  }

  @Get("manifest")
  @Roles("viewer")
  @ApiOperation({
    summary: "The workspace's fonts as a renderer manifest",
    description:
      "The sanitised fonts in the same shape as `getBundledFontManifest`, with " +
      "five-minute signed URLs on each face. The browser and the cloud renderer " +
      "read this and the bundled manifest with one loader.",
    operationId: "getWorkspaceFontManifest",
  })
  @ApiOkResponse(zodResponse(fontManifestViewSchema, "Signed manifest, valid five minutes."))
  async manifest(@CurrentWorkspace() workspaceId: string): Promise<unknown> {
    return this.fonts.manifest(workspaceId);
  }

  @Post("init")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(FONT_RATE_LIMITS.initUpload)
  @ApiOperation({
    summary: "Begin a custom font upload",
    description:
      "Checks the plan's custom-font allowance, opens a row and returns a " +
      "single-shot presigned PUT plus the exact licence warranty the uploader " +
      "must be shown. PUT the file, then call `completeFontUpload`.",
    operationId: "initFontUpload",
  })
  @ApiBody(zodBody(initFontUploadSchema))
  @ApiCreatedResponse(zodResponse(fontUploadTicketSchema, "A presigned PUT and the warranty."))
  @ApiForbiddenResponse({ description: "`fonts/plan_limit_reached`." })
  async init(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: InitFontUploadDto,
  ): Promise<FontUploadTicket> {
    return this.fonts.initUpload(workspaceId, body);
  }

  @Get(":fontId")
  @Roles("viewer")
  @ApiOperation({ summary: "One custom font", operationId: "getWorkspaceFont" })
  @ApiOkResponse(zodResponse(workspaceFontSchema, "The font."))
  @ApiNotFoundResponse({ description: "`fonts/not_found`." })
  async get(
    @CurrentWorkspace() workspaceId: string,
    @Param("fontId") fontId: string,
  ): Promise<WorkspaceFontView> {
    return this.fonts.get(workspaceId, fontId);
  }

  @Get(":fontId/url")
  @Roles("viewer")
  @ApiOperation({
    summary: "Signed URLs for one font's bytes",
    description:
      "The sanitised original for the cloud renderer and the subset WOFF2 for " +
      "the browser, valid five minutes, scoped to the owning workspace: a font " +
      "id from another workspace is a 404.",
    operationId: "getWorkspaceFontUrls",
  })
  @ApiOkResponse(zodResponse(fontUrlsSchema, "Short-lived download URLs."))
  @ApiNotFoundResponse({ description: "`fonts/not_found`." })
  async urls(
    @CurrentWorkspace() workspaceId: string,
    @Param("fontId") fontId: string,
  ): Promise<FontUrls> {
    return this.fonts.urls(workspaceId, fontId);
  }

  @Post(":fontId/complete")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(FONT_RATE_LIMITS.complete)
  @ApiOperation({
    summary: "Attest the licence and sanitise the font",
    description:
      "Records the uploader's licence warranty (`licenceAttestedBy`, " +
      "`attestedAt`, the attestation text version), then validates the file, " +
      "subsets it to the declared scripts and writes the WOFF2 the browser " +
      "loads. Without `licenceAttested: true` nothing is processed. Idempotent.",
    operationId: "completeFontUpload",
  })
  @ApiBody(zodBody(completeFontUploadSchema))
  @ApiCreatedResponse(zodResponse(workspaceFontSchema, "The sanitised font."))
  @ApiUnprocessableEntityResponse({
    description: "`fonts/attestation_required` or a `fonts/*` validation refusal.",
  })
  async complete(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("fontId") fontId: string,
    @Body() body: CompleteFontUploadDto,
  ): Promise<WorkspaceFontView> {
    return this.fonts.complete(workspaceId, fontId, userId, body);
  }

  @Delete(":fontId")
  @Roles("admin")
  @ApiOperation({
    summary: "Delete a custom font",
    description: "Removes the row and both objects. Projects using it fall back.",
    operationId: "deleteWorkspaceFont",
  })
  @ApiOkResponse({ description: "`{ deleted: true }`." })
  @ApiNotFoundResponse({ description: "`fonts/not_found`." })
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("fontId") fontId: string,
  ): Promise<{ deleted: true }> {
    const result = await this.fonts.remove(workspaceId, fontId);
    await this.audit.record({
      action: "workspace.font.deleted",
      resource: "font",
      resourceId: fontId,
      actorId: userId,
      workspaceId,
    });
    return result;
  }
}

/**
 * `POST /fonts/{fontId}/complete` — the brief's own spelling of completion.
 *
 * A separate controller because the path is not under `/workspaces`: a font id
 * is globally unique and the browser that has just PUT a file should not have to
 * repeat which workspace it is in. Ownership is proved the same way regardless —
 * the lookup joins through `fonts.workspace_id` using the token's `ws` claim, so
 * another tenant's font id is a 404 (THREAT-MODEL T5).
 */
@ApiTags("fonts")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("fonts")
export class FontUploadsController {
  constructor(private readonly fonts: FontsService) {}

  @Post(":fontId/complete")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(FONT_RATE_LIMITS.complete)
  @ApiOperation({
    summary: "Attest the licence and sanitise the font (unscoped form)",
    description: "As `completeFontUpload`, without repeating the workspace id.",
    operationId: "completeFontUploadUnscoped",
  })
  @ApiBody(zodBody(completeFontUploadSchema))
  @ApiCreatedResponse(zodResponse(workspaceFontSchema, "The sanitised font."))
  @ApiNotFoundResponse({ description: "`fonts/not_found`." })
  async complete(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("fontId") fontId: string,
    @Body() body: CompleteFontUploadDto,
  ): Promise<WorkspaceFontView> {
    return this.fonts.complete(workspaceId, fontId, userId, body);
  }
}
