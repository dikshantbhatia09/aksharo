import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { evaluateAgeGate, isPlausibleDateOfBirth } from "./age-gate.js";
import { AUTH_AUDIT_ACTIONS, AuthAuditService } from "./auth-audit.service.js";
import { AuthMailerService } from "./auth-mailer.service.js";
import {
  AUTH_ERRORS,
  EMAIL_VERIFICATION_TTL_SEC,
  MAGIC_LINK_TTL_SEC,
  redisKeys,
  URL_TOKEN_BYTES,
} from "./auth.constants.js";
import { BreachedPasswordService } from "./breached-password.service.js";
import { PasswordService } from "./password.service.js";
import { SessionService } from "./session.service.js";
import { randomToken, sha256Hex } from "./tokens.js";
import { AppException, ERROR_CODES, PrismaService, RedisService } from "../common/index.js";
import { parentalWaitlistRow } from "../privacy/parental-waitlist.js";
import { normaliseEmail, UsersService } from "../users/users.service.js";

import type { IssuedTokens } from "./session.service.js";
import type { ConsentChoices } from "../users/users.service.js";
import type { $Enums } from "@prisma/client";

export interface RequestContextInfo {
  readonly ip?: string;
  readonly ua?: string;
}

export interface SignUpInput extends RequestContextInfo {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
  readonly locale?: string;
  readonly dateOfBirth: string;
  readonly jurisdiction: $Enums.Jurisdiction;
  readonly consents?: ConsentChoices;
}

export interface SignInInput extends RequestContextInfo {
  readonly email: string;
  readonly password: string;
  readonly kind?: $Enums.ClientKind;
}

/**
 * Sign-up never says whether an address is already registered.
 *
 * A registration form that answers "that email is taken" is a free account
 * checker, and a verified list of customer addresses is the input to credential
 * stuffing (THREAT-MODEL T1). Every sign-up therefore ends the same way: accepted,
 * check your email. The mail that arrives differs -- verify this address, or "you
 * already have an account" -- and only the mailbox owner sees which.
 */
export interface SignUpResult {
  readonly status: "verification_sent";
  readonly email: string;
}

/**
 * Email/password, email verification and magic links.
 *
 * OAuth lives in `GoogleOAuthService` and the device grant in `DeviceCodeService`;
 * what they share is `SessionService` (families and tokens) and `UsersService`
 * (accounts and personal workspaces).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
    private readonly breaches: BreachedPasswordService,
    private readonly mailer: AuthMailerService,
    private readonly audit: AuthAuditService,
  ) {}

  async signUp(input: SignUpInput): Promise<SignUpResult> {
    const email = normaliseEmail(input.email);
    const dateOfBirth = parseDateOfBirth(input.dateOfBirth);

    // The age gate runs first, so a blocked minor is told why before being asked
    // to fix a password they will never use (D60).
    const verdict = evaluateAgeGate({ dateOfBirth, jurisdiction: input.jurisdiction });
    if (!verdict.allowed) {
      await this.audit.record({
        action: AUTH_AUDIT_ACTIONS.ageRestricted,
        resource: "user",
        ...(input.ip === undefined ? {} : { ip: input.ip }),
        data: { jurisdiction: input.jurisdiction, minimumAge: verdict.minimumAge },
      });
      throw new AppException(
        AUTH_ERRORS.ageRestricted,
        `You need to be at least ${String(verdict.minimumAge)} to sign up in your region. ` +
          "A parent or guardian can join the waitlist to be told when family accounts open.",
        HttpStatus.FORBIDDEN,
        {
          minimumAge: verdict.minimumAge,
          jurisdiction: input.jurisdiction,
          waitlistPath: "/auth/parental-waitlist",
        },
      );
    }

    this.passwords.assertAcceptable(input.password, email);
    const breach = await this.breaches.check(input.password);
    if (breach.breached === true) {
      throw new AppException(
        AUTH_ERRORS.breachedPassword,
        "This password has appeared in a public data breach. Choose a different one.",
        HttpStatus.BAD_REQUEST,
        { reason: "breached" },
      );
    }

    const existing = await this.users.findByEmail(email);
    if (existing !== null && existing.deletedAt === null) {
      // Same response either way; only the mailbox owner learns the difference.
      if (existing.emailVerifiedAt === null) {
        await this.sendVerificationEmail(existing.id, email, existing);
      }
      this.logger.log({ reason: "duplicate" }, "sign-up for an existing address");
      return { status: "verification_sent", email };
    }

    const passwordHash = await this.passwords.hash(input.password);
    const created = await this.users.createWithPersonalWorkspace({
      email,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      passwordHash,
      dateOfBirth,
      jurisdiction: input.jurisdiction,
      ageBracket: verdict.ageBracket,
      ...(input.consents === undefined ? {} : { consents: input.consents }),
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      ...(input.ua === undefined ? {} : { ua: input.ua }),
    });

    // The row was written a line ago, so its locale and name are the input's —
    // reading them back would be a query for values already in hand.
    await this.sendVerificationEmail(created.userId, email, {
      locale: input.locale ?? null,
      name: input.name ?? null,
    });
    await this.audit.record({
      action: AUTH_AUDIT_ACTIONS.signupStarted,
      resource: "user",
      resourceId: created.userId,
      actorId: created.userId,
      workspaceId: created.workspaceId,
      ...(input.ip === undefined ? {} : { ip: input.ip }),
      data: { jurisdiction: input.jurisdiction, ageBracket: verdict.ageBracket },
    });

    return { status: "verification_sent", email };
  }

  /** Consume an email-verification token. Single-use: the key is deleted first. */
  async verifyEmail(token: string, context: RequestContextInfo): Promise<{ verified: true }> {
    const userId = await this.consumeToken(redisKeys.emailVerification(sha256Hex(token)));
    if (userId === undefined) {
      throw new AppException(
        AUTH_ERRORS.invalidToken,
        "This verification link is no longer valid. Request a new one.",
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.users.markEmailVerified(userId);
    await this.audit.record({
      action: AUTH_AUDIT_ACTIONS.emailVerified,
      resource: "user",
      resourceId: userId,
      actorId: userId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
    });
    return { verified: true };
  }

  async signIn(input: SignInInput): Promise<IssuedTokens> {
    const email = normaliseEmail(input.email);
    const user = await this.users.findByEmail(email);

    // Runs even when there is no user: `verify(null, ...)` still pays for a full
    // argon2 hash, so the timing does not answer "does this address exist".
    const correct = await this.passwords.verify(
      user === null || user.deletedAt !== null ? null : user.passwordHash,
      input.password,
    );

    if (user === null || user.deletedAt !== null || !correct) {
      await this.audit.record({
        action: AUTH_AUDIT_ACTIONS.loginFailed,
        resource: "user",
        ...(user === null ? {} : { resourceId: user.id }),
        ...(input.ip === undefined ? {} : { ip: input.ip }),
      });
      throw invalidCredentials();
    }

    if (user.emailVerifiedAt === null) {
      await this.sendVerificationEmail(user.id, email, user);
      throw new AppException(
        AUTH_ERRORS.emailNotVerified,
        "Confirm your email address first. We have sent you a new link.",
        HttpStatus.FORBIDDEN,
      );
    }

    // Cheap parameter upgrade: the plaintext is in hand exactly once per login.
    if (user.passwordHash !== null && this.passwords.needsRehash(user.passwordHash)) {
      await this.users.setPasswordHash(user.id, await this.passwords.hash(input.password));
    }

    return this.startSession(user.id, input.kind ?? "web", input, AUTH_AUDIT_ACTIONS.login);
  }

  /**
   * Request a magic link. Always reports success.
   *
   * An address with no account gets no mail and the caller cannot tell -- the same
   * anti-enumeration rule as sign-up.
   */
  async requestMagicLink(email: string, context: RequestContextInfo): Promise<void> {
    const normalised = normaliseEmail(email);
    const user = await this.users.findByEmail(normalised);

    if (user !== null && user.deletedAt === null) {
      const token = randomToken(URL_TOKEN_BYTES);
      await this.redis.client.set(
        redisKeys.magicLink(sha256Hex(token)),
        user.id,
        "EX",
        MAGIC_LINK_TTL_SEC,
      );
      await this.mailer.send({
        to: normalised,
        template: "magic_link",
        token,
        link: this.mailer.webLink("/auth/magic-link", { token }),
        ...mailRecipient(user),
      });
      await this.audit.record({
        action: AUTH_AUDIT_ACTIONS.magicLinkRequested,
        resource: "user",
        resourceId: user.id,
        ...(context.ip === undefined ? {} : { ip: context.ip }),
      });
    }
  }

  /**
   * Spend a magic link.
   *
   * Clicking the link proves control of the mailbox, so it also verifies the
   * address: a user who signed up and went straight to the magic link never has to
   * confirm twice.
   */
  async consumeMagicLink(
    token: string,
    kind: $Enums.ClientKind,
    context: RequestContextInfo,
  ): Promise<IssuedTokens> {
    const userId = await this.consumeToken(redisKeys.magicLink(sha256Hex(token)));
    if (userId === undefined) {
      throw new AppException(
        AUTH_ERRORS.invalidToken,
        "This sign-in link is no longer valid. Request a new one.",
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
      select: { id: true },
    });

    return this.startSession(userId, kind, context, AUTH_AUDIT_ACTIONS.magicLinkConsumed);
  }

  /**
   * Switch the active workspace (CONTRACTS section 5, THREAT-MODEL T4).
   *
   * Membership is re-checked here and the result is bound into a NEW token and a
   * NEW session, which is what makes the `ws` claim trustworthy everywhere else:
   * no guard ever has to ask a header which workspace a request meant.
   */
  async exchangeToken(
    userId: string,
    workspaceId: string,
    kind: $Enums.ClientKind,
    context: RequestContextInfo,
  ): Promise<IssuedTokens> {
    const membership = await this.users.membership(userId, workspaceId);
    if (membership === null || membership.status !== "active") {
      throw new AppException(
        AUTH_ERRORS.notAMember,
        "You are not a member of that workspace.",
        HttpStatus.FORBIDDEN,
      );
    }

    const issued = await this.sessions.issue({
      userId,
      workspaceId,
      role: membership.role,
      kind,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      ...(context.ua === undefined ? {} : { ua: context.ua }),
    });

    await this.audit.record({
      action: AUTH_AUDIT_ACTIONS.tokenExchanged,
      resource: "session",
      resourceId: issued.sessionId,
      actorId: userId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { role: membership.role },
    });
    return issued;
  }

  /**
   * Record a parental-consent waitlist entry (D60).
   *
   * A04 had to park these in the Redis hash `montaj:auth:parental-waitlist`
   * because `06-data-model.md` has no table for them and the schema was frozen
   * outside A03. A05 adds `parental_waitlist` and this writes there instead;
   * `ParentalWaitlistService` drains whatever the hash still holds at boot.
   *
   * Only `sha256(address)` is stored, which is also what makes a resubmission
   * idempotent — the unique index absorbs it, so `createdAt` is not reset either.
   */
  async joinParentalWaitlist(
    email: string,
    context: RequestContextInfo,
    jurisdiction?: $Enums.Jurisdiction,
  ): Promise<void> {
    await this.prisma.parentalWaitlist.createMany({
      data: parentalWaitlistRow({
        email: normaliseEmail(email),
        // The endpoint is only ever offered to a sign-up the age gate refused, so
        // `minor` is what the entry means; the jurisdiction is whatever that form
        // declared, and `OTHER` when the client did not carry it over.
        ...(jurisdiction === undefined ? {} : { jurisdiction }),
        ageBracket: "minor",
      }),
      skipDuplicates: true,
    });
    await this.audit.record({
      action: AUTH_AUDIT_ACTIONS.parentalWaitlistJoined,
      resource: "parental_waitlist",
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      ...(jurisdiction === undefined ? {} : { data: { jurisdiction } }),
    });
  }

  /** Audit a sign-out. The session is already revoked by the time this runs. */
  async recordLogout(
    session: { id: string; userId: string; workspaceId: string; familyId: string },
    ip?: string,
  ): Promise<void> {
    await this.audit.record({
      action: AUTH_AUDIT_ACTIONS.logout,
      resource: "session",
      resourceId: session.id,
      actorId: session.userId,
      workspaceId: session.workspaceId,
      ...(ip === undefined ? {} : { ip }),
      data: { familyId: session.familyId },
    });
  }

  /** Pass-through so controllers depend on one service rather than two. */
  async recordAudit(entry: Parameters<AuthAuditService["record"]>[0]): Promise<void> {
    await this.audit.record(entry);
  }

  /** Mint the first tokens of a session and write the audit rows. */
  async startSession(
    userId: string,
    kind: $Enums.ClientKind,
    context: RequestContextInfo,
    action: (typeof AUTH_AUDIT_ACTIONS)[keyof typeof AUTH_AUDIT_ACTIONS],
    workspaceId?: string,
  ): Promise<IssuedTokens> {
    const target =
      workspaceId === undefined
        ? await this.users.defaultWorkspace(userId)
        : await this.membershipOrThrow(userId, workspaceId);

    if (target === null) {
      // Only reachable if a workspace was deleted out from under its owner.
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
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      ...(context.ua === undefined ? {} : { ua: context.ua }),
    });

    await this.users.touchLastSeen(userId);
    await this.audit.record({
      action,
      resource: "session",
      resourceId: issued.sessionId,
      actorId: userId,
      workspaceId: target.workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { kind },
    });
    return issued;
  }

  private async membershipOrThrow(
    userId: string,
    workspaceId: string,
  ): Promise<{ workspaceId: string; role: $Enums.MembershipRole }> {
    const membership = await this.users.membership(userId, workspaceId);
    if (membership === null || membership.status !== "active") {
      throw new AppException(
        AUTH_ERRORS.notAMember,
        "You are not a member of that workspace.",
        HttpStatus.FORBIDDEN,
      );
    }
    return { workspaceId, role: membership.role };
  }

  /**
   * `recipient` is what the message is rendered from: A25 writes in the
   * recipient's own language and greets them by name, and `users.locale` is the
   * only place either is recorded. It is optional because one caller — the
   * sign-up that has just created the row — has the values in hand and should not
   * read them back.
   */
  private async sendVerificationEmail(
    userId: string,
    email: string,
    recipient: MailRecipient = {},
  ): Promise<void> {
    const token = randomToken(URL_TOKEN_BYTES);
    await this.redis.client.set(
      redisKeys.emailVerification(sha256Hex(token)),
      userId,
      "EX",
      EMAIL_VERIFICATION_TTL_SEC,
    );
    await this.mailer.send({
      to: email,
      template: "email_verification",
      token,
      link: this.mailer.webLink("/auth/verify-email", { token }),
      ...mailRecipient(recipient),
    });
  }

  /**
   * Read and delete in one round trip.
   *
   * `GETDEL` is what makes these tokens single-use under concurrency: two clicks
   * on the same link race inside Redis, and only one of them gets a value back.
   */
  private async consumeToken(key: string): Promise<string | undefined> {
    const value = await this.redis.client.getdel(key);
    return value === null ? undefined : value;
  }
}

/** Date-only, as `users.date_of_birth` is a `date` column. */
function parseDateOfBirth(value: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!isPlausibleDateOfBirth(parsed)) {
    throw new AppException(
      ERROR_CODES.validationFailed,
      "Enter a valid date of birth.",
      HttpStatus.BAD_REQUEST,
      { field: "dateOfBirth" },
    );
  }
  return parsed;
}

/** One message for "no such account" and "wrong password" alike. */
function invalidCredentials(): AppException {
  return new AppException(
    AUTH_ERRORS.invalidCredentials,
    "That email address and password do not match.",
    HttpStatus.UNAUTHORIZED,
  );
}

/**
 * What A25's templates need about the person, from whatever row is already in
 * hand: `users.locale` and `users.name`, both nullable.
 */
interface MailRecipient {
  readonly locale?: string | null;
  readonly name?: string | null;
}

/**
 * The recipient's language and name, as `AuthMail` fields.
 *
 * Absent keys rather than `undefined` ones, because `AuthMail` is spread into the
 * notify payload and an explicit `undefined` would override the template's own
 * fallback ("Hi there" / "नमस्ते जी") with nothing at all.
 */
function mailRecipient(recipient: MailRecipient): { locale?: string; name?: string } {
  return {
    ...(recipient.locale === undefined || recipient.locale === null
      ? {}
      : { locale: recipient.locale }),
    ...(recipient.name === undefined || recipient.name === null ? {} : { name: recipient.name }),
  };
}
