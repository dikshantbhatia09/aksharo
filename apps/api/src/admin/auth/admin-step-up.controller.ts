import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { ADMIN_AUTH_RATE_LIMITS } from "./admin-step-up.constants.js";
import { AdminStepUpResponseDto, TotpCodeDto, TotpEnrollResponseDto } from "./admin-step-up.dto.js";
import { AdminStepUpService } from "./admin-step-up.service.js";
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { clientIp } from "../../common/guards/principal.js";
import { RateLimit, RateLimitGuard } from "../../common/guards/rate-limit.guard.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";

/**
 * `POST /admin/auth/step-up` and its TOTP enrolment, CONTRACTS §5 (amended
 * 2026-09-03 after B13). Guarded by {@link JwtAuthGuard} alone — a plain
 * `web`/`desktop` session — never {@link AdminGuard}, which requires the
 * `kind: "admin"` token this endpoint exists to mint.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "The caller holds no active admin role." })
@UseGuards(JwtAuthGuard, RateLimitGuard)
@Controller("admin/auth")
export class AdminStepUpController {
  constructor(
    private readonly stepUp: AdminStepUpService,
    private readonly prisma: PrismaService,
  ) {}

  @Post("totp/enroll")
  @HttpCode(HttpStatus.OK)
  @RateLimit(ADMIN_AUTH_RATE_LIMITS.totpEnrollUser)
  @ApiOperation({
    summary: "Start TOTP enrolment for an admin account",
    operationId: "adminTotpEnroll",
  })
  @ApiOkResponse({ type: TotpEnrollResponseDto })
  async enroll(@Req() request: AuthenticatedRequest): Promise<TotpEnrollResponseDto> {
    const principal = requirePrincipal(request);
    const user = await this.prisma.user.findUnique({
      where: { id: principal.userId },
      select: { email: true },
    });
    const result = await this.stepUp.enroll(principal.userId, user?.email ?? principal.userId);
    return { secret: result.secret, otpauthUrl: result.otpauthUrl };
  }

  @Post("totp/verify")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(ADMIN_AUTH_RATE_LIMITS.totpVerifyUser)
  @ApiOperation({
    summary: "Confirm TOTP enrolment with the first valid code",
    operationId: "adminTotpVerify",
  })
  async verify(@Req() request: AuthenticatedRequest, @Body() body: TotpCodeDto): Promise<void> {
    const principal = requirePrincipal(request);
    await this.stepUp.verifyEnrollment(principal.userId, body.code);
  }

  @Post("step-up")
  @HttpCode(HttpStatus.OK)
  @RateLimit(ADMIN_AUTH_RATE_LIMITS.stepUpUser, ADMIN_AUTH_RATE_LIMITS.stepUpIp)
  @ApiOperation({
    summary: "Exchange a normal session plus a TOTP code for a 30-minute admin token",
    description: 'CONTRACTS §5: mints `kind: "admin"`, never refreshable.',
    operationId: "adminStepUp",
  })
  @ApiOkResponse({ type: AdminStepUpResponseDto })
  async stepUpToAdmin(
    @Req() request: AuthenticatedRequest,
    @Body() body: TotpCodeDto,
  ): Promise<AdminStepUpResponseDto> {
    const principal = requirePrincipal(request);
    const result = await this.stepUp.stepUp(
      principal.userId,
      principal.workspaceId,
      principal.role,
      body.code,
      clientIp(request),
    );
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      adminRoles: [...result.adminRoles],
    };
  }
}

function requirePrincipal(request: AuthenticatedRequest) {
  const principal = request.principal;
  if (principal === undefined) {
    throw new AppException(
      ERROR_CODES.unauthorized,
      "Authentication is required.",
      HttpStatus.UNAUTHORIZED,
    );
  }
  return principal;
}
