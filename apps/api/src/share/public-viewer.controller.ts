import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { type Env, surfaceEnabled } from "@montaj/config";

import { ShareLinksService } from "./share-links.service.js";
import { SHARE_RATE_LIMITS, SHARE_SESSION_HEADER } from "./share.constants.js";
import {
  ReportAbuseDto,
  reportAbuseSchema,
  shareDecisionSchema,
  ShareDecisionDto,
  shareResolveSchema,
  unlockShareLinkSchema,
  UnlockShareLinkDto,
} from "./share.dto.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import { Public, RateLimit, RateLimitGuard } from "../common/guards/index.js";
import { ENV } from "../config/config.module.js";

export interface ShareResolveResponse {
  readonly projectId: string;
  readonly title: string;
  readonly scope: string;
  readonly requiresPassword: boolean;
  readonly unlocked: boolean;
  readonly expired: boolean;
  readonly revoked: boolean;
  readonly reviewStatus: string;
  readonly aspect: string;
}

/**
 * The public review surface (B15 brief §1, §3): `GET/POST /s/:token`.
 *
 * No `JwtAuthGuard` anywhere in this controller — that is the point of a share
 * link — but every route is `@Public()` explicitly (rather than simply omitting
 * a guard) so a reviewer scanning for "which routes skip auth" finds all of them
 * decorated, and every mutating one wears `RateLimitGuard` keyed on IP
 * (THREAT-MODEL T21: an unauthenticated surface is the one an attacker can hit
 * for free).
 *
 * `noindex`/no-directory-listing (D70) is a response-header concern the web
 * app's `/(public)/s/[token]` route owns; this controller only ever answers a
 * request that already names an exact token.
 */
@ApiTags("share-public")
@Controller("s")
export class PublicViewerController {
  constructor(
    private readonly shareLinks: ShareLinksService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private assertSurfaceEnabled(): void {
    if (!surfaceEnabled("publicShares", this.env.FEATURE_FLAGS_JSON)) {
      throw new NotFoundException({
        error: { code: "common/not_found", message: "Not found." },
      });
    }
  }

  @Get(":token")
  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimit(SHARE_RATE_LIMITS.resolveToken)
  @ApiOperation({ summary: "Resolve a share link", operationId: "resolveShareLink" })
  @ApiOkResponse(zodResponse(shareResolveSchema, "Share-link state for the viewer."))
  async resolve(
    @Param("token") token: string,
    @Headers(SHARE_SESSION_HEADER) session: string | undefined,
  ): Promise<ShareResolveResponse> {
    this.assertSurfaceEnabled();
    const { shareLink, project, requiresPassword, unlocked } = await this.shareLinks.resolve(
      token,
      session,
    );
    if (unlocked) await this.shareLinks.recordView(shareLink.id);
    return {
      projectId: project.id,
      title: project.title,
      scope: shareLink.scope,
      requiresPassword,
      unlocked,
      expired: false,
      revoked: false,
      reviewStatus: project.reviewStatus,
      aspect: project.aspect,
    };
  }

  @Post(":token/unlock")
  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimit(SHARE_RATE_LIMITS.unlockToken)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Unlock a password-gated share link", operationId: "unlockShareLink" })
  @ApiBody(zodBody(unlockShareLinkSchema))
  async unlock(
    @Param("token") token: string,
    @Body() body: UnlockShareLinkDto,
  ): Promise<{ session: string }> {
    this.assertSurfaceEnabled();
    const session = await this.shareLinks.unlock(token, body.password);
    return { session };
  }

  @Post(":token/report")
  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimit(SHARE_RATE_LIMITS.reportAbuse)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Report abuse on a shared preview (F-504)",
    operationId: "reportShareLink",
  })
  @ApiBody(zodBody(reportAbuseSchema))
  async report(
    @Param("token") token: string,
    @Body() body: ReportAbuseDto,
  ): Promise<{ id: string; dueAt: string }> {
    this.assertSurfaceEnabled();
    return this.shareLinks.report(token, body);
  }

  @Post(":token/decision")
  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimit(SHARE_RATE_LIMITS.postComment)
  @ApiOperation({
    summary: "Approve or request changes (scope `approve` only)",
    operationId: "decideShareLink",
  })
  @ApiBody(zodBody(shareDecisionSchema))
  async decide(
    @Param("token") token: string,
    @Body() body: ShareDecisionDto,
  ): Promise<{ projectId: string; reviewStatus: string }> {
    this.assertSurfaceEnabled();
    return this.shareLinks.decide(token, body.decision);
  }

  @Get(":token/preview")
  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimit(SHARE_RATE_LIMITS.resolveToken)
  @ApiOperation({
    summary: "Proxy URL + EDG projection for the CanvasKit preview",
    operationId: "previewShareLink",
  })
  async preview(
    @Param("token") token: string,
    @Headers(SHARE_SESSION_HEADER) session: string | undefined,
  ): Promise<{
    proxyUrl: string;
    facesUrl?: string;
    durationMs: number | null;
    aspect: string;
    projection: unknown;
  }> {
    this.assertSurfaceEnabled();
    return this.shareLinks.preview(token, session);
  }
}
