import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";
import { z } from "zod";

import { BRAND } from "@montaj/config";
import type { Env } from "@montaj/config";

import { evaluateAgeGate, isPlausibleDateOfBirth } from "./age-gate.js";
import { AUTH_AUDIT_ACTIONS, AuthAuditService } from "./auth-audit.service.js";
import {
  AUTH_ERRORS,
  OAUTH_HANDOFF_TTL_SEC,
  OAUTH_STATE_TTL_SEC,
  redisKeys,
  URL_TOKEN_BYTES,
} from "./auth.constants.js";
import { GOOGLE_OAUTH_PROVIDER } from "./google-oauth.provider.js";
import { SessionService } from "./session.service.js";
import { codeChallengeS256, generateCodeVerifier, randomToken, sha256Hex } from "./tokens.js";
import { AppException, PrismaService, RedisService } from "../common/index.js";
import { ENV } from "../config/config.module.js";
import { normaliseEmail, UsersService } from "../users/users.service.js";

import type { GoogleOAuthProvider, GoogleProfile } from "./google-oauth.provider.js";
import type { IssuedTokens } from "./session.service.js";
import type { ConsentChoices } from "../users/users.service.js";
import type { $Enums } from "@prisma/client";

/** Which client started the flow, and therefore where the callback goes back to. */
export const OAUTH_CLIENTS = ["web", "desktop", "bridge"] as const;
export type OAuthClient = (typeof OAUTH_CLIENTS)[number];

/** The token `kind` each client gets (CONTRACTS section 5). */
const CLIENT_TOKEN_KIND: Readonly<Record<OAuthClient, $Enums.ClientKind>> = {
  web: "web",
  desktop: "desktop",
  bridge: "bridge",
};

const stateSchema = z.object({
  verifier: z.string().min(43),
  client: z.enum(OAUTH_CLIENTS),
  redirectUri: z.string().min(1),
});

const handoffSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("login"), userId: z.string().min(1), client: z.enum(OAUTH_CLIENTS) }),
  z.object({
    kind: z.literal("registration"),
    client: z.enum(OAUTH_CLIENTS),
    profile: z.object({
      subject: z.string().min(1),
      email: z.string().min(1),
      emailVerified: z.boolean(),
      name: z.string().optional(),
    }),
  }),
]);

type Handoff = z.infer<typeof handoffSchema>;

export interface StartResult {
  readonly authorizationUrl: string;
  readonly state: string;
}

export interface CallbackResult {
  /** Where the browser is sent next, handoff code included. */
  readonly redirectTo: string;
  readonly status: "login" | "registration";
}

export interface CompleteInput {
  readonly code: string;
  readonly dateOfBirth?: string;
  readonly jurisdiction?: $Enums.Jurisdiction;
  readonly consents?: ConsentChoices;
  readonly ip?: string;
  readonly ua?: string;
}

/**
 * Google sign-in with PKCE (05 section 8, brief section 2).
 *
 * Two Redis entries carry the flow:
 *
 *   * `oauth:state:<state>` -- the PKCE verifier and the originating client, for
 *     10 minutes. Consumed exactly once, which is what makes the callback immune
 *     to CSRF: a callback the API did not start has no state entry.
 *   * `oauth:handoff:<sha256(code)>` -- the result of the callback, for 5 minutes,
 *     exchanged at `POST /auth/oauth/complete`.
 *
 * Tokens never travel in the redirect. A redirect URL reaches browser history, the
 * `Referer` header of the next request and, for `aksharo://`, every process on the
 * user's machine that can claim the scheme; a single-use code that must be POSTed
 * back does not.
 */
@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly audit: AuthAuditService,
    @Inject(GOOGLE_OAUTH_PROVIDER) private readonly provider: GoogleOAuthProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `{API_ORIGIN}/auth/oauth/google/callback` -- registered with Google once. */
  get redirectUri(): string {
    return new URL("/auth/oauth/google/callback", this.env.API_ORIGIN).toString();
  }

  async start(client: OAuthClient, loginHint?: string): Promise<StartResult> {
    if (!this.provider.configured) {
      throw new AppException(
        AUTH_ERRORS.providerUnavailable,
        "Signing in with Google is not configured.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const state = randomToken(URL_TOKEN_BYTES);
    const verifier = generateCodeVerifier();
    await this.redis.client.set(
      redisKeys.oauthState(state),
      JSON.stringify({ verifier, client, redirectUri: this.redirectUri }),
      "EX",
      OAUTH_STATE_TTL_SEC,
    );

    return {
      state,
      authorizationUrl: this.provider.authorizationUrl({
        state,
        codeChallenge: codeChallengeS256(verifier),
        redirectUri: this.redirectUri,
        ...(loginHint === undefined ? {} : { loginHint }),
      }),
    };
  }

  async handleCallback(code: string, state: string): Promise<CallbackResult> {
    const stored = await this.redis.client.getdel(redisKeys.oauthState(state));
    if (stored === null) {
      throw new AppException(
        AUTH_ERRORS.invalidToken,
        "This sign-in attempt has expired. Start again.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const parsed = stateSchema.safeParse(JSON.parse(stored));
    if (!parsed.success) {
      throw new AppException(
        AUTH_ERRORS.invalidToken,
        "This sign-in attempt is not valid.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const profile = await this.provider.exchangeCode({
      code,
      codeVerifier: parsed.data.verifier,
      redirectUri: parsed.data.redirectUri,
    });

    const handoff = await this.resolveIdentity(profile, parsed.data.client);
    const handoffCode = randomToken(URL_TOKEN_BYTES);
    await this.redis.client.set(
      redisKeys.oauthHandoff(sha256Hex(handoffCode)),
      JSON.stringify(handoff),
      "EX",
      OAUTH_HANDOFF_TTL_SEC,
    );

    return {
      status: handoff.kind,
      redirectTo: this.clientRedirect(parsed.data.client, handoffCode, handoff.kind),
    };
  }

  /**
   * Exchange the handoff code for tokens.
   *
   * A brand-new Google account still has to pass the age gate: Google does not
   * supply a date of birth, and D60 requires one at sign-up. The callback therefore
   * reports `status=registration`, the client collects the date of birth and the
   * jurisdiction, and this call finishes the account.
   */
  async complete(input: CompleteInput): Promise<IssuedTokens> {
    const stored = await this.redis.client.getdel(redisKeys.oauthHandoff(sha256Hex(input.code)));
    if (stored === null) {
      throw new AppException(
        AUTH_ERRORS.invalidToken,
        "This sign-in code has expired. Start again.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const parsed = handoffSchema.safeParse(JSON.parse(stored));
    if (!parsed.success) {
      throw new AppException(
        AUTH_ERRORS.invalidToken,
        "This sign-in code is not valid.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const kind = CLIENT_TOKEN_KIND[parsed.data.client];
    const context = {
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      ...(input.ua === undefined ? {} : { ua: input.ua }),
    };

    if (parsed.data.kind === "login") {
      return this.startSessionFor(parsed.data.userId, kind, context);
    }

    if (input.dateOfBirth === undefined || input.jurisdiction === undefined) {
      throw new AppException(
        AUTH_ERRORS.registrationIncomplete,
        "Tell us your date of birth and region to finish creating your account.",
        HttpStatus.BAD_REQUEST,
        { required: ["dateOfBirth", "jurisdiction"] },
      );
    }

    return this.register(parsed.data.profile, input, kind, context);
  }

  /** Does this Google identity already belong to somebody? */
  private async resolveIdentity(profile: GoogleProfile, client: OAuthClient): Promise<Handoff> {
    const identity = await this.prisma.identity.findUnique({
      where: { provider_providerId: { provider: "google", providerId: profile.subject } },
      select: { userId: true, user: { select: { deletedAt: true } } },
    });
    if (identity !== null && identity.user.deletedAt === null) {
      return { kind: "login", userId: identity.userId, client };
    }

    // Link to an existing password account only when Google says the address is
    // verified. Without that check, anyone able to set an unverified address at a
    // provider could take over an account by "signing in with Google".
    if (profile.emailVerified) {
      const existing = await this.users.findByEmail(profile.email);
      if (existing !== null && existing.deletedAt === null) {
        await this.linkIdentity(existing.id, profile);
        return { kind: "login", userId: existing.id, client };
      }
    }

    return {
      kind: "registration",
      client,
      profile: {
        subject: profile.subject,
        email: normaliseEmail(profile.email),
        emailVerified: profile.emailVerified,
        ...(profile.name === undefined ? {} : { name: profile.name }),
      },
    };
  }

  private async linkIdentity(userId: string, profile: GoogleProfile): Promise<void> {
    await this.prisma.identity.create({
      data: {
        id: ulid(),
        userId,
        provider: "google",
        providerId: profile.subject,
        // The raw profile is stored for support, never rendered to a user.
        raw: { email: profile.email, emailVerified: profile.emailVerified },
      },
    });
    await this.audit.record({
      action: AUTH_AUDIT_ACTIONS.oauthLinked,
      resource: "identity",
      resourceId: userId,
      actorId: userId,
      data: { provider: "google" },
    });
  }

  private async register(
    profile: { subject: string; email: string; emailVerified: boolean; name?: string },
    input: CompleteInput,
    kind: $Enums.ClientKind,
    context: { ip?: string; ua?: string },
  ): Promise<IssuedTokens> {
    const dateOfBirth = new Date(`${String(input.dateOfBirth)}T00:00:00.000Z`);
    if (!isPlausibleDateOfBirth(dateOfBirth)) {
      throw new AppException(
        AUTH_ERRORS.registrationIncomplete,
        "Enter a valid date of birth.",
        HttpStatus.BAD_REQUEST,
        { field: "dateOfBirth" },
      );
    }

    const jurisdiction = input.jurisdiction ?? "OTHER";
    const verdict = evaluateAgeGate({ dateOfBirth, jurisdiction });
    if (!verdict.allowed) {
      await this.audit.record({
        action: AUTH_AUDIT_ACTIONS.ageRestricted,
        resource: "user",
        ...(context.ip === undefined ? {} : { ip: context.ip }),
        data: { jurisdiction, minimumAge: verdict.minimumAge, provider: "google" },
      });
      throw new AppException(
        AUTH_ERRORS.ageRestricted,
        `You need to be at least ${String(verdict.minimumAge)} to sign up in your region.`,
        HttpStatus.FORBIDDEN,
        {
          minimumAge: verdict.minimumAge,
          jurisdiction,
          waitlistPath: "/auth/parental-waitlist",
        },
      );
    }

    const created = await this.users.createWithPersonalWorkspace({
      email: profile.email,
      ...(profile.name === undefined ? {} : { name: profile.name }),
      dateOfBirth,
      jurisdiction,
      ageBracket: verdict.ageBracket,
      // Google asserted the address; a second confirmation email would be theatre.
      emailVerified: profile.emailVerified,
      ...(input.consents === undefined ? {} : { consents: input.consents }),
      ...context,
    });

    await this.linkIdentity(created.userId, {
      subject: profile.subject,
      email: profile.email,
      emailVerified: profile.emailVerified,
    });

    const issued = await this.sessions.issue({
      userId: created.userId,
      workspaceId: created.workspaceId,
      role: created.role,
      kind,
      ...context,
    });
    await this.audit.record({
      action: AUTH_AUDIT_ACTIONS.signupStarted,
      resource: "user",
      resourceId: created.userId,
      actorId: created.userId,
      workspaceId: created.workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { provider: "google", ageBracket: verdict.ageBracket },
    });
    return issued;
  }

  private async startSessionFor(
    userId: string,
    kind: $Enums.ClientKind,
    context: { ip?: string; ua?: string },
  ): Promise<IssuedTokens> {
    const target = await this.users.defaultWorkspace(userId);
    if (target === null) {
      throw new AppException(
        AUTH_ERRORS.notAMember,
        "This account has no active workspace.",
        HttpStatus.FORBIDDEN,
      );
    }

    const issued = await this.sessions.issue({
      userId,
      workspaceId: target.workspaceId,
      role: target.role,
      kind,
      ...context,
    });
    await this.users.touchLastSeen(userId);
    await this.audit.record({
      action: AUTH_AUDIT_ACTIONS.login,
      resource: "session",
      resourceId: issued.sessionId,
      actorId: userId,
      workspaceId: target.workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { provider: "google", kind },
    });
    return issued;
  }

  /**
   * Where the browser goes after the callback.
   *
   * The web app is sent straight to its own origin. A desktop or panel client goes
   * to an https landing page on the API first, which then triggers
   * `{scheme}://auth-callback`: Adobe UXP and several desktop shells refuse to
   * follow a custom scheme in a top-level redirect, but will follow a click or a
   * script on a page they already trust (brief section 2).
   */
  private clientRedirect(client: OAuthClient, code: string, status: Handoff["kind"]): string {
    if (client === "web") {
      const url = new URL("/auth/callback", this.env.WEB_ORIGIN);
      url.searchParams.set("code", code);
      url.searchParams.set("status", status);
      return url.toString();
    }

    const url = new URL("/auth/desktop-landing", this.env.API_ORIGIN);
    url.searchParams.set("code", code);
    url.searchParams.set("status", status);
    url.searchParams.set("client", client);
    return url.toString();
  }

  /** The deep link the landing page triggers, e.g. `aksharo://auth-callback?...`. */
  deepLinkFor(code: string, status: string): string {
    const url = new URL(`${BRAND.deepLinkScheme}://auth-callback`);
    url.searchParams.set("code", code);
    url.searchParams.set("status", status);
    return url.toString();
  }

  /** Log a callback that Google itself rejected, without echoing its text back. */
  logProviderError(error: string): void {
    this.logger.warn({ error: error.slice(0, 64) }, "google returned an oauth error");
  }
}
