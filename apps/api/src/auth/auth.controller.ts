import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { AUTH_AUDIT_ACTIONS } from "./auth-audit.service.js";
import { RATE_LIMITS } from "./auth.constants.js";
import { AuthService } from "./auth.service.js";
import {
  LoginDto,
  LogoutDto,
  MagicLinkConsumeDto,
  MagicLinkRequestDto,
  ParentalWaitlistDto,
  RefreshDto,
  SignUpDto,
  TokenExchangeDto,
  VerifyEmailDto,
  loginSchema,
  logoutSchema,
  magicLinkConsumeSchema,
  magicLinkRequestSchema,
  parentalWaitlistSchema,
  refreshSchema,
  sessionSummarySchema,
  signUpResponseSchema,
  signUpSchema,
  tokenExchangeSchema,
  tokenResponseSchema,
  verifyEmailSchema,
} from "./dto/auth.dto.js";
import { zodArrayResponse, zodBody, zodResponse } from "./dto/openapi.js";
import { SessionService } from "./session.service.js";
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

import type { IssuedTokens, SessionSummary } from "./session.service.js";
import type { AuthPrincipal } from "../common/guards/index.js";
import type { Request } from "express";

/**
 * Email, password, magic link, refresh, sessions and workspace exchange.
 *
 * Every route on this controller is behind `RateLimitGuard` (THREAT-MODEL T1) and
 * either `@Public()` or `JwtAuthGuard`. There is no third state: a route that
 * forgets to say which is protected by default, because the class-level guard runs
 * on everything.
 */
@ApiTags("auth")
@Controller("auth")
@UseGuards(JwtAuthGuard, RolesGuard, RateLimitGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post("signup")
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(RATE_LIMITS.signupIp)
  @ApiOperation({
    summary: "Create an account",
    description:
      "Always answers the same way, whether or not the address is already registered: " +
      "a registration form that says 'already taken' is a free account checker. " +
      "Blocked by the age gate (403 auth/age_restricted) for India under 18 and the EU under 16.",
  })
  @ApiBody(zodBody(signUpSchema))
  @ApiCreatedResponse(zodResponse(signUpResponseSchema, "Verification email sent."))
  @ApiForbiddenResponse({ description: "auth/age_restricted" })
  @ApiTooManyRequestsResponse({ description: "common/rate_limited; carries Retry-After." })
  signUp(@Body() body: SignUpDto, @Req() request: Request) {
    return this.auth.signUp({ ...body, ...context(request) });
  }

  @Post("verify-email")
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(RATE_LIMITS.verifyEmailIp)
  @ApiOperation({ summary: "Confirm an email address with a single-use token" })
  @ApiBody(zodBody(verifyEmailSchema))
  verifyEmail(@Body() body: VerifyEmailDto, @Req() request: Request) {
    return this.auth.verifyEmail(body.token, context(request));
  }

  @Post("login")
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(RATE_LIMITS.loginIp, RATE_LIMITS.loginAccount)
  @ApiOperation({
    summary: "Sign in with email and password",
    description:
      "One message for an unknown address and a wrong password alike, and the same " +
      "argon2 cost is paid either way.",
  })
  @ApiBody(zodBody(loginSchema))
  @ApiOkResponse(zodResponse(tokenResponseSchema, "Access and refresh tokens."))
  @ApiUnauthorizedResponse({ description: "auth/invalid_credentials" })
  login(@Body() body: LoginDto, @Req() request: Request): Promise<IssuedTokens> {
    return this.auth.signIn({ ...body, ...context(request) });
  }

  @Post("magic-link")
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(RATE_LIMITS.magicLinkIp, RATE_LIMITS.magicLinkAccount)
  @ApiOperation({ summary: "Email a single-use sign-in link (15 minutes)" })
  @ApiBody(zodBody(magicLinkRequestSchema))
  @ApiOkResponse({ description: "Accepted, whether or not the address has an account." })
  async requestMagicLink(@Body() body: MagicLinkRequestDto, @Req() request: Request) {
    await this.auth.requestMagicLink(body.email, context(request));
    return { status: "sent" as const };
  }

  @Post("magic-link/consume")
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(RATE_LIMITS.verifyEmailIp)
  @ApiOperation({ summary: "Exchange a magic-link token for tokens" })
  @ApiBody(zodBody(magicLinkConsumeSchema))
  @ApiOkResponse(zodResponse(tokenResponseSchema, "Access and refresh tokens."))
  consumeMagicLink(
    @Body() body: MagicLinkConsumeDto,
    @Req() request: Request,
  ): Promise<IssuedTokens> {
    return this.auth.consumeMagicLink(body.token, body.kind ?? "web", context(request));
  }

  @Post("refresh")
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(RATE_LIMITS.refreshIp)
  @ApiOperation({
    summary: "Rotate a refresh token",
    description:
      "Rotation with a 60-second grace: presenting the previous token inside the window " +
      "replays the same new pair, presenting it after the window revokes the whole family.",
  })
  @ApiBody(zodBody(refreshSchema))
  @ApiOkResponse(zodResponse(tokenResponseSchema, "A rotated token pair."))
  @ApiUnauthorizedResponse({ description: "common/unauthorized or auth/session_revoked" })
  refresh(@Body() body: RefreshDto, @Req() request: Request): Promise<IssuedTokens> {
    return this.sessions.refresh(body.refreshToken, { ip: clientIp(request) });
  }

  @Post("logout")
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(RATE_LIMITS.refreshIp)
  @ApiOperation({
    summary: "Revoke a refresh-token family",
    description:
      "Takes the refresh token rather than the access token, so a client whose access " +
      "token has already expired can still sign out. Always 204: an unknown token must " +
      "not be a way to test whether a token is live.",
  })
  @ApiBody(zodBody(logoutSchema))
  @ApiNoContentResponse({ description: "Signed out." })
  async logout(@Body() body: LogoutDto, @Req() request: Request): Promise<void> {
    const session = await this.sessions.sessionForToken(body.refreshToken);
    if (session === null) return;
    await this.sessions.revokeFamily(session.familyId, "logout");
    await this.auth.recordLogout(session, clientIp(request));
  }

  @Post("token/exchange")
  @HttpCode(HttpStatus.OK)
  @RateLimit(RATE_LIMITS.tokenExchangeUser)
  @ApiOperation({
    summary: "Switch the active workspace",
    description:
      "The workspace is bound into the access token; there is no X-Workspace-Id header " +
      "(07 section Conventions, THREAT-MODEL T4). Membership is re-checked here.",
  })
  @ApiBody(zodBody(tokenExchangeSchema))
  @ApiOkResponse(zodResponse(tokenResponseSchema, "Tokens for the requested workspace."))
  @ApiForbiddenResponse({ description: "auth/not_a_member" })
  exchange(
    @Body() body: TokenExchangeDto,
    @CurrentUser() principal: AuthPrincipal,
    @Req() request: Request,
  ): Promise<IssuedTokens> {
    return this.auth.exchangeToken(
      principal.userId,
      body.workspaceId,
      principal.kind,
      context(request),
    );
  }

  @Get("sessions")
  @ApiOperation({ summary: "List this account's live sessions" })
  @ApiOkResponse(zodArrayResponse(sessionSummarySchema, "Live sessions, newest first."))
  listSessions(@CurrentUser() principal: AuthPrincipal): Promise<SessionSummary[]> {
    // `jti` is the session id (see `SessionService.withAccessToken`), which is how
    // the caller's own session is marked `current`.
    return this.sessions.list(principal.userId, principal.jti);
  }

  @Delete("sessions/:sessionId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Revoke one session (and its refresh-token family)" })
  @ApiNoContentResponse({ description: "Revoked." })
  async revokeSession(
    @Param("sessionId") sessionId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Req() request: Request,
  ): Promise<void> {
    const { familyId } = await this.sessions.revokeById(principal.userId, sessionId);
    await this.auth.recordAudit({
      action: AUTH_AUDIT_ACTIONS.sessionRevoked,
      resource: "session",
      resourceId: sessionId,
      actorId: principal.userId,
      workspaceId: principal.workspaceId,
      ip: clientIp(request),
      data: { familyId },
    });
  }

  @Post("parental-waitlist")
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(RATE_LIMITS.waitlistIp)
  @ApiOperation({
    summary: "Join the parental-consent waitlist",
    description:
      "Offered to a sign-up blocked by the age gate (D60), until a verifiable " +
      "parental-consent flow ships.",
  })
  @ApiBody(zodBody(parentalWaitlistSchema))
  async joinWaitlist(@Body() body: ParentalWaitlistDto, @Req() request: Request) {
    await this.auth.joinParentalWaitlist(body.email, context(request), body.jurisdiction);
    return { status: "joined" as const };
  }
}

/** IP and user agent, for rate limits, audit rows and session records. */
function context(request: Request): { ip: string; ua?: string } {
  const ua = clientUserAgent(request);
  return { ip: clientIp(request), ...(ua === undefined ? {} : { ua }) };
}
