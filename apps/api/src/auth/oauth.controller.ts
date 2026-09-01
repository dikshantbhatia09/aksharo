import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  Inject,
} from "@nestjs/common";
import {
  ApiBody,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";

import { BRAND } from "@montaj/config";
import type { Env } from "@montaj/config";

import { RATE_LIMITS } from "./auth.constants.js";
import {
  clientIp,
  clientUserAgent,
  JwtAuthGuard,
  Public,
  RateLimit,
  RateLimitGuard,
} from "../common/guards/index.js";
import { ENV } from "../config/config.module.js";
import {
  OAuthCompleteDto,
  oauthClientSchema,
  oauthCompleteSchema,
  tokenResponseSchema,
} from "./dto/auth.dto.js";
import { zodBody, zodResponse } from "./dto/openapi.js";
import { GoogleOAuthService } from "./google-oauth.service.js";

import type { OAuthClient } from "./google-oauth.service.js";
import type { IssuedTokens } from "./session.service.js";
import type { Request, Response } from "express";

/**
 * Google sign-in (PKCE) and the desktop landing page.
 *
 * `start` and `callback` are browser navigations, so they answer with redirects
 * rather than JSON; `complete` is the only JSON endpoint, and it is what actually
 * hands over tokens.
 */
@ApiTags("auth")
@Controller("auth")
@UseGuards(JwtAuthGuard, RateLimitGuard)
export class OAuthController {
  constructor(
    private readonly google: GoogleOAuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get("oauth/google/start")
  @Public()
  @RateLimit(RATE_LIMITS.oauthStartIp)
  @ApiOperation({
    summary: "Begin Google sign-in",
    description:
      "Stores the PKCE verifier and the originating client for 10 minutes, then " +
      "redirects to Google. `client` decides where the callback sends the browser back to.",
  })
  @ApiQuery({ name: "client", enum: ["web", "desktop", "bridge"], required: false })
  @ApiQuery({ name: "loginHint", required: false })
  async start(
    @Res() response: Response,
    @Query("client") client?: string,
    @Query("loginHint") loginHint?: string,
  ): Promise<void> {
    const parsed = oauthClientSchema.safeParse(client ?? "web");
    const target: OAuthClient = parsed.success ? parsed.data : "web";
    const { authorizationUrl } = await this.google.start(
      target,
      typeof loginHint === "string" && loginHint !== "" ? loginHint : undefined,
    );
    response.redirect(HttpStatus.FOUND, authorizationUrl);
  }

  @Get("oauth/google/callback")
  @Public()
  @ApiOperation({
    summary: "Google redirects here",
    description:
      "Exchanges the authorization code, links or creates the identity, and redirects " +
      "on with a single-use handoff code. Tokens are never put in a redirect URL.",
  })
  async callback(
    @Res() response: Response,
    @Query("code") code?: string,
    @Query("state") state?: string,
    @Query("error") error?: string,
  ): Promise<void> {
    if (typeof error === "string" && error !== "") {
      this.google.logProviderError(error);
      response.redirect(HttpStatus.FOUND, this.failureRedirect("provider_error"));
      return;
    }
    if (typeof code !== "string" || code === "" || typeof state !== "string" || state === "") {
      response.redirect(HttpStatus.FOUND, this.failureRedirect("missing_parameters"));
      return;
    }

    const result = await this.google.handleCallback(code, state);
    response.redirect(HttpStatus.FOUND, result.redirectTo);
  }

  /**
   * The https page that triggers the desktop deep link.
   *
   * Adobe UXP and several desktop shells will not follow a custom scheme in a
   * top-level redirect from a third-party origin, but they will follow one from a
   * page the user is already looking at. This page is that page (brief section 2).
   * It is excluded from the OpenAPI document: it is a browser destination, not
   * something `@montaj/api-client` should generate a method for.
   */
  @Get("desktop-landing")
  @Public()
  @ApiExcludeEndpoint()
  landing(
    @Res() response: Response,
    @Query("code") code?: string,
    @Query("status") status?: string,
  ): void {
    const safeCode = typeof code === "string" ? code.replace(/[^A-Za-z0-9_-]/g, "") : "";
    const safeStatus = status === "registration" ? "registration" : "login";
    const deepLink = this.google.deepLinkFor(safeCode, safeStatus);

    // No third-party assets and no scripts: a CSP that forbids everything the page
    // does not need, and a `noindex` so the URL never turns up in a search result.
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    response.setHeader("X-Robots-Tag", "noindex");
    response.setHeader("Referrer-Policy", "no-referrer");
    response
      .status(safeCode === "" ? HttpStatus.BAD_REQUEST : HttpStatus.OK)
      .type("html")
      .send(landingHtml(deepLink, safeCode !== ""));
  }

  @Post("oauth/complete")
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(RATE_LIMITS.oauthStartIp)
  @ApiOperation({
    summary: "Exchange the handoff code for tokens",
    description:
      "When the callback reported `status=registration` this call must also carry " +
      "`dateOfBirth` and `jurisdiction`: Google does not supply a date of birth and " +
      "D60 requires one before an account exists.",
  })
  @ApiBody(zodBody(oauthCompleteSchema))
  @ApiOkResponse(zodResponse(tokenResponseSchema, "Access and refresh tokens."))
  complete(@Body() body: OAuthCompleteDto, @Req() request: Request): Promise<IssuedTokens> {
    const ua = clientUserAgent(request);
    return this.google.complete({
      ...body,
      ip: clientIp(request),
      ...(ua === undefined ? {} : { ua }),
    });
  }

  private failureRedirect(reason: string): string {
    const url = new URL("/auth/callback", this.env.WEB_ORIGIN);
    url.searchParams.set("status", "error");
    url.searchParams.set("reason", reason);
    return url.toString();
  }
}

/**
 * The landing page markup.
 *
 * `deepLink` is built from a sanitised code, so it contains no characters that
 * need escaping in an attribute; the assertion is kept honest by escaping anyway.
 */
function landingHtml(deepLink: string, ok: boolean): string {
  const href = escapeHtml(deepLink);
  const heading = ok ? `Return to ${BRAND.name}` : "Something went wrong";
  const body = ok
    ? "Opening the app. If nothing happens, use the button below."
    : "This sign-in link is incomplete. Start again from the app.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${ok ? `<meta http-equiv="refresh" content="0; url=${href}">` : ""}
<title>${escapeHtml(BRAND.name)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center;
         min-height: 100vh; background: #0d0d0f; color: #f4f4f5; }
  main { text-align: center; padding: 2rem; max-width: 28rem; }
  a.button { display: inline-block; margin-top: 1.5rem; padding: .75rem 1.5rem; border-radius: .5rem;
             background: #f4f4f5; color: #0d0d0f; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(body)}</p>
  ${ok ? `<a class="button" href="${href}">Open ${escapeHtml(BRAND.name)}</a>` : ""}
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
