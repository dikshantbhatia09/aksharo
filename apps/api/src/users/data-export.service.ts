import { createHash, randomBytes } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import type { Env } from "@montaj/config";

import {
  ACCOUNT_ERRORS,
  DATA_EXPORT_TOKEN_BYTES,
  DATA_EXPORT_TTL_SEC,
  accountRedisKeys,
} from "./account.constants.js";
import { A05_AUDIT_ACTIONS, AuditService } from "./audit.service.js";
import { dsrDueAt } from "./profile.service.js";
import { AppException, PrismaService, RedisService } from "../common/index.js";
import { ENV } from "../config/config.module.js";

import type { RequestContextInfo } from "./profile.service.js";
import type { $Enums } from "@prisma/client";

export interface DataExportView {
  readonly requestId: string;
  readonly status: $Enums.DsrStatus;
  readonly requestedAt: string;
  readonly dueAt: string;
  readonly downloadUrl?: string;
  readonly expiresAt?: string;
  readonly sizeBytes?: number;
}

/** The bundle `GET /me/data` produces. Versioned so a later shape is detectable. */
export interface DataExportBundle {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly requestId: string;
  readonly user: unknown;
  readonly consents: readonly unknown[];
  readonly memberships: readonly unknown[];
  readonly workspaces: readonly unknown[];
  readonly sessions: readonly unknown[];
  readonly identities: readonly unknown[];
  readonly rightsRequests: readonly unknown[];
  readonly memoryEntries: readonly unknown[];
  /** B16: every media asset the user's own workspaces hold — not the bytes, the manifest. */
  readonly mediaManifest: readonly unknown[];
  /** What is deliberately absent, so the recipient is not left guessing. */
  readonly notIncluded: readonly string[];
}

/**
 * `GET /me/data` — the DPDP access/portability right (D70, 07 §Privacy & rights).
 *
 * The shape is the one B16 will keep: a `dsr_requests` row of kind `export` is
 * the record that the right was exercised, `evidenceKey` names the object, and
 * the caller gets a short-lived signed URL rather than the bundle inline (a
 * bundle can be large, and a URL can be re-fetched without re-running the query).
 *
 * Two things here are deliberately provisional, and both are one-line swaps:
 *
 *   * the bundle is **built inline** rather than on a queue. There is no queue
 *     name for a rights export in CONTRACTS §3, and at Wave-1 volumes the build
 *     is a dozen indexed reads. When B16 adds the media and transcript rows it
 *     becomes a job, and `build()` is what that job will call.
 *   * the object is stored in **Redis** under the hash of the download token,
 *     because the API has no object-store client until A06 and inventing one for
 *     a 30-kilobyte JSON would be the wrong trade. `evidenceKey` already records
 *     the R2 key the object will have.
 *
 * The URL is "signed" in the only sense that matters: it carries 256 bits of
 * one-time entropy that only the requester was ever shown, it expires in an hour,
 * and the stored copy is addressed by the token's hash, so a Redis dump does not
 * hand anybody a working link.
 */
@Injectable()
export class DataExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Create the request, build the bundle and hand back a download link. */
  async request(
    userId: string,
    workspaceId: string,
    context: RequestContextInfo,
  ): Promise<DataExportView> {
    const now = new Date();
    const requestId = ulid();
    const dueAt = dsrDueAt(now);

    await this.prisma.dsrRequest.create({
      data: {
        id: requestId,
        userId,
        kind: "export",
        receivedAt: now,
        dueAt,
        status: "in_progress",
        evidenceKey: evidenceKey(userId, requestId),
      },
    });

    const bundle = await this.build(userId, requestId);
    const body = JSON.stringify(bundle, null, 2);
    const token = randomBytes(DATA_EXPORT_TOKEN_BYTES).toString("base64url");

    await this.redis.client.set(
      accountRedisKeys.dataExport(sha256Hex(token)),
      JSON.stringify({ userId, requestId, body }),
      "EX",
      DATA_EXPORT_TTL_SEC,
    );

    await this.prisma.dsrRequest.update({
      where: { id: requestId },
      data: { status: "completed", completedAt: new Date() },
    });

    await this.audit.record({
      action: A05_AUDIT_ACTIONS.dataExportRequested,
      resource: "dsr_request",
      resourceId: requestId,
      actorId: userId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { kind: "export", sizeBytes: Buffer.byteLength(body) },
    });

    return {
      requestId,
      status: "completed",
      requestedAt: now.toISOString(),
      dueAt: dueAt.toISOString(),
      downloadUrl: this.downloadUrl(requestId, token),
      expiresAt: new Date(now.getTime() + DATA_EXPORT_TTL_SEC * 1_000).toISOString(),
      sizeBytes: Buffer.byteLength(body),
    };
  }

  /**
   * Redeem a download token.
   *
   * Single-use: the entry is deleted as it is read, so a link that leaks out of a
   * browser history or a shared screenshot is already spent. The request id in
   * the path must match the one the token was issued for, which makes a
   * mismatched pair indistinguishable from an expired one.
   */
  async download(requestId: string, token: string, ip?: string): Promise<string> {
    const key = accountRedisKeys.dataExport(sha256Hex(token));
    const raw = await this.redis.client.get(key);
    if (raw === null) throw notReady();

    const entry = JSON.parse(raw) as { userId: string; requestId: string; body: string };
    if (entry.requestId !== requestId) throw notReady();

    await this.redis.client.del(key);
    await this.audit.record({
      action: A05_AUDIT_ACTIONS.dataExportDownloaded,
      resource: "dsr_request",
      resourceId: requestId,
      actorId: entry.userId,
      ...(ip === undefined ? {} : { ip }),
    });
    return entry.body;
  }

  /**
   * Everything the account holds about the person, as one JSON document.
   *
   * Rows are projected rather than dumped: a `password_hash` or a
   * `refresh_token_hash` in an export is a credential the user can be phished
   * out of, and neither is personal data the right covers.
   */
  async build(userId: string, requestId: string): Promise<DataExportBundle> {
    const [user, consents, memberships, sessions, identities, rights, memory] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          emailVerifiedAt: true,
          name: true,
          avatarUrl: true,
          locale: true,
          dateOfBirth: true,
          jurisdiction: true,
          ageBracket: true,
          marketingOptIn: true,
          analyticsConsentAt: true,
          memoryConsentAt: true,
          onboarding: true,
          createdAt: true,
          lastSeenAt: true,
          deletedAt: true,
        },
      }),
      this.prisma.consentRecord.findMany({
        where: { userId },
        orderBy: { grantedAt: "asc" },
        select: {
          purpose: true,
          version: true,
          noticeVersion: true,
          granted: true,
          grantedAt: true,
          withdrawnAt: true,
          workspaceId: true,
        },
      }),
      this.prisma.membership.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: { workspaceId: true, role: true, status: true, createdAt: true },
      }),
      this.prisma.session.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          kind: true,
          workspaceId: true,
          ip: true,
          ua: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
        },
      }),
      this.prisma.identity.findMany({
        where: { userId },
        select: { provider: true, createdAt: true },
      }),
      this.prisma.dsrRequest.findMany({
        where: { userId },
        orderBy: { receivedAt: "asc" },
        select: {
          id: true,
          kind: true,
          receivedAt: true,
          dueAt: true,
          status: true,
          completedAt: true,
        },
      }),
      this.prisma.memoryEntry.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: { kind: true, value: true, workspaceId: true, createdAt: true, expiresAt: true },
      }),
    ]);

    const workspaceIds = memberships.map((row) => row.workspaceId);
    const workspaces =
      workspaceIds.length === 0
        ? []
        : await this.prisma.workspace.findMany({
            where: { id: { in: workspaceIds } },
            select: {
              id: true,
              slug: true,
              name: true,
              type: true,
              region: true,
              currency: true,
              billingCountry: true,
              billingStateCode: true,
              legalName: true,
              createdAt: true,
            },
          });

    // B16: the media manifest — filenames, sizes and durations, not bytes.
    // Scoped to workspaces owned by the requester (`ownerId`), the same
    // narrowing `ErasureCascadeService` uses, rather than every workspace a
    // membership row lists: a team member's export should not enumerate the
    // whole team's media.
    const ownedWorkspaceIds = (
      await this.prisma.workspace.findMany({ where: { ownerId: userId }, select: { id: true } })
    ).map((row) => row.id);
    const mediaRows =
      ownedWorkspaceIds.length === 0
        ? []
        : await this.prisma.mediaAsset.findMany({
            where: { project: { workspaceId: { in: ownedWorkspaceIds } } },
            select: {
              id: true,
              projectId: true,
              filename: true,
              sizeBytes: true,
              durationMs: true,
              mime: true,
              status: true,
              createdAt: true,
            },
            take: 5_000,
          });
    // `sizeBytes` is a `BigInt` column; `JSON.stringify` cannot serialise one.
    const mediaManifest = mediaRows.map((row) => ({
      ...row,
      sizeBytes: row.sizeBytes === null ? null : row.sizeBytes.toString(),
    }));

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      requestId,
      user,
      consents,
      memberships,
      workspaces,
      sessions,
      identities,
      rightsRequests: rights,
      memoryEntries: memory,
      mediaManifest,
      notIncluded: [
        "password and MFA secrets (credentials, not personal data)",
        "refresh tokens and their hashes",
        "media bytes, transcripts and rendered export bytes themselves — the " +
          "manifest above lists what exists; the objects are not embedded in this JSON",
        "billing documents, which are retained for 72 months under Rule 46",
      ],
    };
  }

  /** `${API_ORIGIN}/me/data/{requestId}?token=…` */
  private downloadUrl(requestId: string, token: string): string {
    const url = new URL(`/me/data/${requestId}`, this.env.API_ORIGIN);
    url.searchParams.set("token", token);
    return url.toString();
  }
}

/** The R2 key the bundle will occupy once A06 gives the API an object store. */
export function evidenceKey(userId: string, requestId: string): string {
  return `u/${userId}/dsr/${requestId}.json`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function notReady(): AppException {
  return new AppException(
    ACCOUNT_ERRORS.exportNotReady,
    "That download link is not valid. Request the export again.",
    HttpStatus.NOT_FOUND,
  );
}
