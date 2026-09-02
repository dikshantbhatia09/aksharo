import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { ACCOUNT_RATE_LIMITS } from "./account.constants.js";
import { DataExportService } from "./data-export.service.js";
import { ProfileService } from "./profile.service.js";
import {
  dataExportSchema,
  erasureSchema,
  profileSchema,
  UpdateProfileDto,
  updateProfileSchema,
} from "./users.dto.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  clientIp,
  clientUserAgent,
  CurrentUser,
  JwtAuthGuard,
  Public,
  RateLimit,
  RateLimitGuard,
  RolesGuard,
} from "../common/guards/index.js";

import type { DataExportView } from "./data-export.service.js";
import type { ErasureResult, ProfileView, RequestContextInfo } from "./profile.service.js";
import type { AuthPrincipal } from "../common/guards/index.js";
import type { Request, Response } from "express";

/**
 * The signed-in person's own account: profile, data export, erasure.
 *
 * Everything here is scoped to `principal.userId`; no route takes a user id, so
 * there is no object to enumerate (THREAT-MODEL T5). The workspace shown on the
 * profile is the one bound into the access token — never a header (T4).
 */
@ApiTags("me")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@Controller("me")
@UseGuards(JwtAuthGuard, RolesGuard, RateLimitGuard)
export class UsersController {
  constructor(
    private readonly profile: ProfileService,
    private readonly exports: DataExportService,
  ) {}

  @Get()
  @ApiOperation({ summary: "The signed-in person's profile", operationId: "getMe" })
  @ApiOkResponse(zodResponse(profileSchema, "The caller's profile."))
  async me(@CurrentUser() principal: AuthPrincipal): Promise<ProfileView> {
    return this.profile.view(principal.userId, {
      id: principal.workspaceId,
      role: principal.role,
    });
  }

  @Patch()
  @ApiOperation({
    summary: "Update name, avatar, locale, onboarding state or marketing opt-in",
    description:
      "A change to `marketingOptIn` also writes a `consent_records` row, because " +
      "the DPDP notice-and-choice record has to say when and from where the choice " +
      "was made (D61).",
    operationId: "updateMe",
  })
  @ApiBody(zodBody(updateProfileSchema))
  @ApiOkResponse(zodResponse(profileSchema, "The updated profile."))
  async update(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: UpdateProfileDto,
    @Req() request: Request,
  ): Promise<ProfileView> {
    return this.profile.update(
      principal.userId,
      { id: principal.workspaceId, role: principal.role },
      body,
      context(request),
    );
  }

  @Get("data")
  @RateLimit(ACCOUNT_RATE_LIMITS.dataExportUser)
  @ApiOperation({
    summary: "Export everything the account holds about you",
    description:
      "Records a `dsr_requests` row of kind `export` (DPDP Rule 14: answered " +
      "within 30 days) and returns a single-use download link that expires in an " +
      "hour. B16 adds media, transcripts and exports to the bundle.",
    operationId: "requestMyData",
  })
  @ApiOkResponse(zodResponse(dataExportSchema, "The rights request and its download link."))
  @ApiTooManyRequestsResponse({ description: "`common/rate_limited`." })
  async requestData(
    @CurrentUser() principal: AuthPrincipal,
    @Req() request: Request,
  ): Promise<DataExportView> {
    return this.exports.request(principal.userId, principal.workspaceId, context(request));
  }

  /**
   * Redeem a download link.
   *
   * `@Public()` on purpose: the link is what the requester was given, it carries
   * 256 bits of one-time entropy, it is spent on first use and it expires in an
   * hour. Requiring a bearer token as well would make the "signed URL" of 07
   * §Privacy & rights something a browser could not simply open.
   *
   * Excluded from the OpenAPI document: it is a link the API mints, not an
   * operation a generated client ever composes.
   */
  @Get("data/:requestId")
  @Public()
  @RateLimit(ACCOUNT_RATE_LIMITS.exportDownloadIp)
  @ApiExcludeEndpoint()
  @Header("Content-Type", "application/json; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async download(
    @Param("requestId") requestId: string,
    @Query("token") token: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const body = await this.exports.download(requestId, token ?? "", clientIp(request));
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="aksharo-data-${requestId}.json"`,
    );
    response.send(body);
  }

  @Delete()
  @RateLimit(ACCOUNT_RATE_LIMITS.erasureUser)
  @ApiOperation({
    summary: "Erase the account",
    description:
      "Records a `dsr_requests` row of kind `erasure`, marks the account deleted, " +
      "anonymises the address and revokes every session immediately. The cascade " +
      "over media, transcripts and derived objects is B16 and has 30 days to run.",
    operationId: "deleteMe",
  })
  @ApiOkResponse(zodResponse(erasureSchema, "The erasure request."))
  async erase(
    @CurrentUser() principal: AuthPrincipal,
    @Req() request: Request,
  ): Promise<ErasureResult> {
    return this.profile.requestErasure(principal.userId, principal.workspaceId, context(request));
  }
}

/** IP and user agent, for rate limits, audit rows and consent records. */
export function context(request: Request): RequestContextInfo {
  const ua = clientUserAgent(request);
  return { ip: clientIp(request), ...(ua === undefined ? {} : { ua }) };
}
