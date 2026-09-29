import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";

import { type Env, surfaceEnabled } from "@montaj/config";

import { ClientReviewService } from "./client-review.service.js";
import { REVIEW_RATE_LIMITS } from "./review.constants.js";
import {
  ClientCommentDto,
  ClientDecisionDto,
  clientCommentSchema,
  clientDecisionSchema,
} from "./review.dto.js";
import { zodBody } from "../../auth/dto/openapi.js";
import { Public, RateLimit, RateLimitGuard, clientIp } from "../../common/guards/index.js";
import { ENV } from "../../config/config.module.js";

import type { PublicClipView, PublicReviewView } from "./review.dto.js";
import type { Request } from "express";

/** The header a review page sends its link's token in (never the path; see below). */
export const REVIEW_TOKEN_HEADER = "x-review-token";

/**
 * Clip review, the client's routes (2026-10-03): `GET /review` and the two
 * writes under it, for someone with a review link and no account.
 *
 * Like the share viewer (`share/public-viewer.controller.ts`): every route is
 * `@Public()` explicitly, rate-limited by address (and, for writes, by link in
 * the service), answers 404 while public links (`shares.public`) are off, and
 * `no-store`, so no cache between here and the page keeps a signed URL.
 *
 * **The token travels in a header** ({@link REVIEW_TOKEN_HEADER}), not in the
 * path the way `/s/:token` does: the request log records every path it serves
 * (`common/logging`), and a token in one would put a working link in the logs
 * of a table built so a copy of it hands out none (`clip_review_links` keeps
 * only the token's hash).
 */
@ApiTags("review-public")
@Controller("review")
export class PublicReviewController {
  constructor(
    private readonly reviews: ClientReviewService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private assertSurfaceEnabled(): void {
    if (!surfaceEnabled("publicShares", this.env.FEATURE_FLAGS_JSON)) {
      throw new NotFoundException({
        error: { code: "common/not_found", message: "Not found." },
      });
    }
  }

  @Get()
  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimit(REVIEW_RATE_LIMITS.publicRead)
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: REVIEW_TOKEN_HEADER, required: true })
  @ApiOperation({
    summary: "Open a review link: the clips it shares",
    description:
      "The video's title and each clip with a captioned 9:16 video (signed for 20 minutes), " +
      "its words, and what was said through this link. 404 `review/link_not_found`; 410 " +
      "`review/link_revoked` or `review/link_expired`.",
    operationId: "openReviewLink",
  })
  async open(@Headers(REVIEW_TOKEN_HEADER) token: string | undefined): Promise<PublicReviewView> {
    this.assertSurfaceEnabled();
    return this.reviews.open(token ?? "");
  }

  @Post("clips/:clipId/decision")
  @Public()
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(REVIEW_RATE_LIMITS.publicWrite)
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: REVIEW_TOKEN_HEADER, required: true })
  @ApiOperation({
    summary: "Approve a clip, or ask for changes, through a review link",
    description:
      "Recorded as the client (`name`, required when the link says so: 400 " +
      "`review/name_required`), never as a member. `note` becomes a comment too. `expect` is " +
      "the video the page played: 409 `review/video_changed` when a newer one replaced it.",
    operationId: "decideReviewLinkClip",
  })
  @ApiBody(zodBody(clientDecisionSchema))
  async decide(
    @Headers(REVIEW_TOKEN_HEADER) token: string | undefined,
    @Param("clipId") clipId: string,
    @Body() body: ClientDecisionDto,
    @Req() request: Request,
  ): Promise<PublicClipView> {
    this.assertSurfaceEnabled();
    return this.reviews.decide(token ?? "", clipId, body, { ip: clientIp(request) });
  }

  @Post("clips/:clipId/comments")
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @RateLimit(REVIEW_RATE_LIMITS.publicWrite)
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: REVIEW_TOKEN_HEADER, required: true })
  @ApiOperation({
    summary: "Comment on a clip through a review link",
    operationId: "commentReviewLinkClip",
  })
  @ApiBody(zodBody(clientCommentSchema))
  async comment(
    @Headers(REVIEW_TOKEN_HEADER) token: string | undefined,
    @Param("clipId") clipId: string,
    @Body() body: ClientCommentDto,
    @Req() request: Request,
  ): Promise<PublicClipView["comments"][number]> {
    this.assertSurfaceEnabled();
    return this.reviews.comment(token ?? "", clipId, body, { ip: clientIp(request) });
  }
}
