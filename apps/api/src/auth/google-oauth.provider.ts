import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { AUTH_ERRORS } from "./auth.constants.js";
import { AppException } from "../common/index.js";
import { ENV } from "../config/config.module.js";

/** Google's fixed OIDC endpoints. Discovery would be one more thing to cache. */
export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const TOKEN_REQUEST_TIMEOUT_MS = 5_000;

/** The subset of a Google profile this product stores. */
export interface GoogleProfile {
  /** The stable `sub` claim. Becomes `identities.provider_id`. */
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name?: string;
  readonly picture?: string;
}

export interface AuthorizationUrlInput {
  readonly state: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly loginHint?: string;
}

export interface ExchangeInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/**
 * The provider port.
 *
 * An interface rather than a concrete class so the e2e suite can substitute a
 * fake Google without a network, which is the only way the callback path is
 * testable at all (acceptance criterion 1).
 */
export interface GoogleOAuthProvider {
  readonly configured: boolean;
  authorizationUrl(input: AuthorizationUrlInput): string;
  exchangeCode(input: ExchangeInput): Promise<GoogleProfile>;
}

export const GOOGLE_OAUTH_PROVIDER = Symbol("GOOGLE_OAUTH_PROVIDER");

/**
 * The real Google, over HTTPS, with PKCE.
 *
 * The ID token's signature is deliberately not verified. It arrives on a direct
 * TLS connection to Google's token endpoint in response to a request carrying our
 * client secret and the PKCE verifier, which is the case OpenID Connect Core
 * section 3.1.3.7 exempts from signature validation. `iss` and `aud` are still
 * checked, so a token minted for another client is rejected.
 */
@Injectable()
export class HttpGoogleOAuthProvider implements GoogleOAuthProvider {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get configured(): boolean {
    return (
      this.env.GOOGLE_OAUTH_CLIENT_ID !== undefined &&
      this.env.GOOGLE_OAUTH_CLIENT_SECRET !== undefined
    );
  }

  authorizationUrl(input: AuthorizationUrlInput): string {
    const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    url.searchParams.set("client_id", this.clientId());
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // Refresh tokens are Google's, not ours; we only need the identity once.
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");
    if (input.loginHint !== undefined) url.searchParams.set("login_hint", input.loginHint);
    return url.toString();
  }

  async exchangeCode(input: ExchangeInput): Promise<GoogleProfile> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: this.clientId(),
      client_secret: this.clientSecret(),
    });

    let response: Response;
    try {
      response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw providerUnavailable(error);
    }

    if (!response.ok) throw providerUnavailable(new Error(`HTTP ${String(response.status)}`));

    const payload = (await response.json()) as { id_token?: unknown };
    if (typeof payload.id_token !== "string") throw providerUnavailable(new Error("no id_token"));

    return parseIdToken(payload.id_token, this.clientId());
  }

  private clientId(): string {
    const value = this.env.GOOGLE_OAUTH_CLIENT_ID;
    if (value === undefined) throw notConfigured();
    return value;
  }

  private clientSecret(): string {
    const value = this.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (value === undefined) throw notConfigured();
    return value;
  }
}

/**
 * Read the claims of an ID token that came straight from the token endpoint.
 *
 * Exported so the fake provider in the tests can produce tokens the same way and
 * so the `iss`/`aud` rules have their own unit test.
 */
export function parseIdToken(idToken: string, expectedAudience: string): GoogleProfile {
  const segments = idToken.split(".");
  if (segments.length !== 3) throw providerUnavailable(new Error("malformed id_token"));

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw providerUnavailable(error);
  }

  const issuer = claims["iss"];
  const audience = claims["aud"];
  const subject = claims["sub"];
  const email = claims["email"];

  if (typeof issuer !== "string" || !GOOGLE_ISSUERS.includes(issuer)) {
    throw providerUnavailable(new Error("unexpected issuer"));
  }
  if (audience !== expectedAudience) throw providerUnavailable(new Error("unexpected audience"));
  if (typeof subject !== "string" || subject === "") {
    throw providerUnavailable(new Error("no subject"));
  }
  if (typeof email !== "string" || email === "") throw providerUnavailable(new Error("no email"));

  const name = claims["name"];
  const picture = claims["picture"];
  return {
    subject,
    email: email.toLowerCase(),
    emailVerified: claims["email_verified"] === true,
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof picture === "string" ? { picture } : {}),
  };
}

function providerUnavailable(cause: unknown): AppException {
  return new AppException(
    AUTH_ERRORS.providerUnavailable,
    "Signing in with Google is not available right now.",
    HttpStatus.BAD_GATEWAY,
    { reason: cause instanceof Error ? cause.message : "unknown" },
  );
}

function notConfigured(): AppException {
  return new AppException(
    AUTH_ERRORS.providerUnavailable,
    "Signing in with Google is not configured.",
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
