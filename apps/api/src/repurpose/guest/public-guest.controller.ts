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
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";

import { type Env, surfaceEnabled } from "@montaj/config";

import { GuestPageService } from "./guest-page.service.js";
import { GUEST_RATE_LIMITS } from "./guest.constants.js";
import { GuestDownloadDto, guestDownloadSchema } from "./guest.dto.js";
import { zodBody } from "../../auth/dto/openapi.js";
import { Public, RateLimit, RateLimitGuard, clientIp } from "../../common/guards/index.js";
import { ENV } from "../../config/config.module.js";

import type { GuestPageView } from "./guest.dto.js";
import type { Request } from "express";

/** The header a guest page sends its link's token in (never the path; see below). */
export const GUEST_TOKEN_HEADER = "x-guest-token";

/**
 * Guest pages, the guest's routes (2026-10-05): `GET /guest` and
 * `POST /guest/downloads`, for someone with a guest link and no account.
 *
 * Like the client review routes (`review/public-review.controller.ts`): every
 * route is `@Public()` explicitly, rate-limited by address (and the download
 * count by link in the service), answers 404 while public links
 * (`shares.public`) are off, and `no-store`, so no cache between here and the
 * page keeps a signed URL.
 *
 * **The token travels in a header** ({@link GUEST_TOKEN_HEADER}), never the
 * path: the request log records every path it serves (`common/logging`), and
 * `clip_guest_links` keeps only the token's hash so that a copy of it hands
 * out no working link. A header of its own, not `x-review-token`: a guest
 * token is looked up only as a guest link, a review token only as a review
 * link.
 */
@ApiTags("guest-public")
@Controller("guest")
export class PublicGuestController {
  constructor(
    private readonly pages: GuestPageService,
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
  @RateLimit(GUEST_RATE_LIMITS.publicRead)
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: GUEST_TOKEN_HEADER, required: true })
  @ApiOperation({
    summary: "Open a guest link: the clips it shares, ready to download",
    description:
      "The video's title, the guest's name, and each shared clip's files (every shape with " +
      "and without captions, its images, its dubbed versions when the link has them), all " +
      "signed for 20 minutes, with its words to post. 404 `guest/link_not_found`; 410 " +
      "`guest/link_revoked` or `guest/link_expired`.",
    operationId: "openGuestLink",
  })
  async open(@Headers(GUEST_TOKEN_HEADER) token: string | undefined): Promise<GuestPageView> {
    this.assertSurfaceEnabled();
    return this.pages.open(token ?? "");
  }

  @Post("downloads")
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RateLimitGuard)
  @RateLimit(GUEST_RATE_LIMITS.publicDownload)
  @Header("Cache-Control", "no-store")
  @ApiHeader({ name: GUEST_TOKEN_HEADER, required: true })
  @ApiOperation({
    summary: "Count a download from a guest page",
    description:
      "Sent by the page as a download starts; the file itself was signed by the page view. " +
      "404 `guest/clip_not_found` for a clip that is not on the page.",
    operationId: "countGuestLinkDownload",
  })
  @ApiBody(zodBody(guestDownloadSchema))
  async download(
    @Headers(GUEST_TOKEN_HEADER) token: string | undefined,
    @Body() body: GuestDownloadDto,
    @Req() request: Request,
  ): Promise<void> {
    this.assertSurfaceEnabled();
    await this.pages.countDownload(token ?? "", body, { ip: clientIp(request) });
  }
}
