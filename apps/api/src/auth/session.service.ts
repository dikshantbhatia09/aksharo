import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { AUTH_AUDIT_ACTIONS, AuthAuditService } from "./auth-audit.service.js";
import {
  AUTH_ERRORS,
  REFRESH_GRACE_SEC,
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_TTL_SEC,
  redisKeys,
} from "./auth.constants.js";
import { TokenService } from "./token.service.js";
import { randomToken, sha256Hex } from "./tokens.js";
import { AppException, ERROR_CODES, PrismaService, RedisService } from "../common/index.js";

import type { $Enums } from "@prisma/client";

/** What every successful authentication returns. */
export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Access-token lifetime in seconds (CONTRACTS section 5: 900). */
  readonly expiresIn: number;
  readonly tokenType: "Bearer";
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly role: $Enums.MembershipRole;
  readonly kind: $Enums.ClientKind;
}

export interface IssueSessionInput {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: $Enums.MembershipRole;
  readonly kind: $Enums.ClientKind;
  readonly ip?: string;
  readonly ua?: string;
  readonly deviceId?: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly kind: $Enums.ClientKind;
  readonly workspaceId: string;
  readonly ip: string | null;
  readonly ua: string | null;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
  readonly expiresAt: Date;
  /** `true` for the session the calling access token was minted from. */
  readonly current: boolean;
}

/** Columns the refresh path needs. */
const SESSION_SELECT = {
  id: true,
  userId: true,
  workspaceId: true,
  kind: true,
  familyId: true,
  refreshTokenHash: true,
  previousHash: true,
  rotatedAt: true,
  revokedAt: true,
  expiresAt: true,
} as const;

interface SessionRow {
  id: string;
  userId: string;
  workspaceId: string;
  kind: $Enums.ClientKind;
  familyId: string;
  refreshTokenHash: string;
  previousHash: string | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}

function unknownToken(): AppException {
  return new AppException(
    ERROR_CODES.unauthorized,
    "The refresh token is not valid.",
    HttpStatus.UNAUTHORIZED,
  );
}

function sessionRevoked(): AppException {
  return new AppException(
    AUTH_ERRORS.sessionRevoked,
    "This session has been revoked. Sign in again.",
    HttpStatus.UNAUTHORIZED,
  );
}

function expiredSession(): AppException {
  return new AppException(
    AUTH_ERRORS.expired,
    "This session has expired. Sign in again.",
    HttpStatus.UNAUTHORIZED,
  );
}

/**
 * Refresh-token families (CONTRACTS section 5, THREAT-MODEL T2).
 *
 * One `sessions` row IS one family. A refresh rotates the row in place: the hash
 * that was just spent moves to `previous_hash`, the new hash replaces it and
 * `rotated_at` records when. That gives three states for a presented token:
 *
 *   * it matches `refresh_token_hash` -- the normal case, rotate.
 *   * it matches `previous_hash` and `rotated_at` is within {@link REFRESH_GRACE_SEC}
 *     -- a retry of a request whose response the client lost (a flaky mobile
 *     network, two tabs racing). The SAME tokens the rotation produced are replayed
 *     from a 60-second Redis entry, so the client ends up holding exactly one live
 *     token rather than two.
 *   * it matches `previous_hash` and the grace has passed -- a replay of a spent
 *     token, which means the token leaked. The whole family is revoked and the
 *     event is audited.
 *
 * Anything else is simply not a token we issued.
 *
 * The membership role is re-read on every rotation rather than copied into the
 * session row, so a demotion in `memberships` reaches the next access token within
 * one access-token lifetime even though the refresh token lives for 30 days.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tokens: TokenService,
    private readonly audit: AuthAuditService,
  ) {}

  /** Start a new family. Called by every sign-in path and by token exchange. */
  async issue(input: IssueSessionInput): Promise<IssuedTokens> {
    const refreshToken = randomToken(REFRESH_TOKEN_BYTES);
    const session = await this.prisma.session.create({
      data: {
        id: ulid(),
        userId: input.userId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        familyId: ulid(),
        refreshTokenHash: sha256Hex(refreshToken),
        deviceId: input.deviceId ?? null,
        ip: input.ip ?? null,
        ua: input.ua ?? null,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
      },
      select: { id: true },
    });

    return this.withAccessToken({
      sessionId: session.id,
      userId: input.userId,
      workspaceId: input.workspaceId,
      role: input.role,
      kind: input.kind,
      refreshToken,
    });
  }

  /**
   * Spend a refresh token.
   *
   * @throws AppException `auth/session_revoked` when reuse revoked the family,
   *         `common/unauthorized` when the token is unknown, `auth/expired` when
   *         the family reached its absolute lifetime.
   */
  async refresh(presentedToken: string, context: { ip?: string }): Promise<IssuedTokens> {
    const presentedHash = sha256Hex(presentedToken);

    const current = await this.prisma.session.findUnique({
      where: { refreshTokenHash: presentedHash },
      select: SESSION_SELECT,
    });
    if (current !== null) {
      // A live token from a family that was revoked (logout, or an earlier reuse)
      // is not itself an incident, but it is not a way back in either.
      if (current.revokedAt !== null) throw sessionRevoked();
      if (current.expiresAt.getTime() <= Date.now()) throw expiredSession();
      return this.rotate(current, presentedHash);
    }

    const previous = await this.prisma.session.findFirst({
      where: { previousHash: presentedHash },
      select: SESSION_SELECT,
    });
    if (previous === null) throw unknownToken();

    const rotatedAt = previous.rotatedAt?.getTime() ?? 0;
    const withinGrace = Date.now() - rotatedAt <= REFRESH_GRACE_SEC * 1000;

    if (!withinGrace || previous.revokedAt !== null) {
      await this.revokeFamily(previous.familyId, "refresh_token_reuse");
      await this.audit.record({
        action: AUTH_AUDIT_ACTIONS.refreshReuseDetected,
        resource: "session",
        resourceId: previous.id,
        actorId: previous.userId,
        workspaceId: previous.workspaceId,
        ...(context.ip === undefined ? {} : { ip: context.ip }),
        data: { familyId: previous.familyId, graceSeconds: REFRESH_GRACE_SEC },
      });
      this.logger.warn(
        { sessionId: previous.id, familyId: previous.familyId },
        "refresh token reuse detected; family revoked",
      );
      throw new AppException(
        AUTH_ERRORS.sessionRevoked,
        "This session has been revoked. Sign in again.",
        HttpStatus.UNAUTHORIZED,
        { reason: "refresh_token_reuse" },
      );
    }

    const replayed = await this.readGrace(presentedHash);
    if (replayed !== undefined) return replayed;

    // Inside the window but the cached response is gone (Redis restarted, or the
    // entry expired a moment early). Rotating again is safe -- the presented token
    // is still the legitimate predecessor -- and beats revoking a healthy family.
    this.logger.warn({ sessionId: previous.id }, "grace replay cache miss; rotating again");
    return this.rotate(previous, previous.refreshTokenHash);
  }

  /** Revoke every session in a family (logout, reuse detection, explicit revoke). */
  async revokeFamily(familyId: string, reason: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count > 0) {
      this.logger.log({ familyId, reason, count: result.count }, "refresh family revoked");
    }
    return result.count;
  }

  /** The live sessions of a user, newest first. */
  async list(userId: string, currentSessionId?: string): Promise<SessionSummary[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        kind: true,
        workspaceId: true,
        ip: true,
        ua: true,
        createdAt: true,
        rotatedAt: true,
        expiresAt: true,
      },
    });
    return rows.map((row) => ({ ...row, current: row.id === currentSessionId }));
  }

  /**
   * Revoke one session by id, on behalf of its owner.
   *
   * The ownership check is the point: without it a session id -- which travels in
   * a list response -- would revoke anybody's session (THREAT-MODEL T5 applied to
   * sessions). A session that is not the caller's is reported as absent.
   */
  async revokeById(userId: string, sessionId: string): Promise<{ familyId: string }> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, familyId: true, workspaceId: true },
    });
    if (session === null || session.userId !== userId) {
      throw new AppException(ERROR_CODES.notFound, "No such session.", HttpStatus.NOT_FOUND);
    }
    await this.revokeFamily(session.familyId, "user_revoked");
    return { familyId: session.familyId };
  }

  /** Find the session a refresh token belongs to, without spending it. */
  async sessionForToken(refreshToken: string): Promise<{
    id: string;
    familyId: string;
    userId: string;
    workspaceId: string;
  } | null> {
    const hash = sha256Hex(refreshToken);
    return this.prisma.session.findFirst({
      where: { OR: [{ refreshTokenHash: hash }, { previousHash: hash }] },
      select: { id: true, familyId: true, userId: true, workspaceId: true },
    });
  }

  private async rotate(session: SessionRow, expectedHash: string): Promise<IssuedTokens> {
    const role = await this.currentRole(session.userId, session.workspaceId);
    const refreshToken = randomToken(REFRESH_TOKEN_BYTES);

    // Conditional update: two concurrent refreshes with the same token race here
    // and exactly one wins. The loser falls through to the grace path, which
    // replays the winner's response instead of revoking a healthy family.
    const updated = await this.prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: expectedHash, revokedAt: null },
      data: {
        refreshTokenHash: sha256Hex(refreshToken),
        previousHash: expectedHash,
        rotatedAt: new Date(),
      },
    });

    if (updated.count !== 1) {
      const replayed = await this.readGrace(expectedHash);
      if (replayed !== undefined) return replayed;
      throw unknownToken();
    }

    const issued = this.withAccessToken({
      sessionId: session.id,
      userId: session.userId,
      workspaceId: session.workspaceId,
      role,
      kind: session.kind,
      refreshToken,
    });

    await this.writeGrace(expectedHash, issued);
    return issued;
  }

  /**
   * The caller's role in the session's workspace right now.
   *
   * A membership that has been removed or suspended ends the session: continuing
   * to mint tokens for a workspace the user was thrown out of is THREAT-MODEL T4.
   */
  private async currentRole(userId: string, workspaceId: string): Promise<$Enums.MembershipRole> {
    const membership = await this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true, status: true },
    });
    if (membership === null || membership.status !== "active") {
      throw new AppException(
        AUTH_ERRORS.notAMember,
        "You are no longer a member of this workspace.",
        HttpStatus.FORBIDDEN,
      );
    }
    return membership.role;
  }

  /** Cache the rotation response so the previous token can replay it for 60 s. */
  private async writeGrace(previousHash: string, issued: IssuedTokens): Promise<void> {
    try {
      await this.redis.client.set(
        redisKeys.refreshGrace(previousHash),
        JSON.stringify(issued),
        "EX",
        REFRESH_GRACE_SEC,
      );
    } catch (error) {
      this.logger.warn({ err: error }, "could not store the rotation grace entry");
    }
  }

  private async readGrace(previousHash: string): Promise<IssuedTokens | undefined> {
    try {
      const cached = await this.redis.client.get(redisKeys.refreshGrace(previousHash));
      return cached === null ? undefined : (JSON.parse(cached) as IssuedTokens);
    } catch (error) {
      this.logger.warn({ err: error }, "could not read the rotation grace entry");
      return undefined;
    }
  }

  private withAccessToken(input: {
    sessionId: string;
    userId: string;
    workspaceId: string;
    role: $Enums.MembershipRole;
    kind: $Enums.ClientKind;
    refreshToken: string;
  }): IssuedTokens {
    const minted = this.tokens.mintAccessToken({
      userId: input.userId,
      workspaceId: input.workspaceId,
      role: input.role,
      kind: input.kind,
      // `jti` IS the session id. Access tokens are not revoked individually --
      // families are (CONTRACTS section 5) -- so the useful thing for a claim to
      // identify is the session that minted it: it correlates audit rows, marks
      // the caller's own entry in `GET /auth/sessions`, and gives A05 onwards a
      // way to reach the session from a request without a second lookup.
      jti: input.sessionId,
    });
    return {
      accessToken: minted.accessToken,
      refreshToken: input.refreshToken,
      expiresIn: minted.expiresIn,
      tokenType: "Bearer",
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      role: input.role,
      kind: input.kind,
    };
  }
}
