import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import {
  SHARE_AUTO_DISABLE_REPORT_THRESHOLD,
  SHARE_ERRORS,
  SHARE_REPORT_SLA_HOURS,
  SHARE_SESSION_TTL_SECONDS,
} from "./share.constants.js";
import { generateShareToken, ShareSessionSigner } from "./token.js";
import { PasswordService } from "../auth/password.service.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException, PrismaService } from "../common/index.js";

import type { CreateShareLinkDto } from "./share.dto.js";
import type { $Enums, ShareLink } from "@prisma/client";

export type ShareScope = "view" | "comment" | "approve";

export interface ShareLinkView {
  readonly id: string;
  readonly projectId: string;
  readonly token: string;
  readonly scope: $Enums.ShareLinkScope;
  readonly hasPassword: boolean;
  readonly expiresAt: string | null;
  readonly maxViews: number | null;
  readonly viewCount: number;
  readonly clientTag: string | null;
  readonly reportCount: number;
  readonly revokedAt: string | null;
  readonly autoDisabled: boolean;
  readonly createdAt: string;
  readonly url: string;
}

/** What the public `/s/:token` resolver returns before rendering anything. */
export interface ResolvedShareLink {
  readonly shareLink: ShareLink;
  readonly project: {
    readonly id: string;
    readonly title: string;
    readonly aspect: string;
    readonly reviewStatus: string;
    readonly workspaceId: string;
    readonly createdBy: string | null;
  };
  readonly requiresPassword: boolean;
  readonly unlocked: boolean;
}

function toView(link: ShareLink, webOrigin: string): ShareLinkView {
  return {
    id: link.id,
    projectId: link.projectId,
    token: link.token,
    scope: link.scope,
    hasPassword: link.passwordHash !== null,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    maxViews: link.maxViews,
    viewCount: link.viewCount,
    clientTag: link.clientTag,
    reportCount: link.reportCount,
    revokedAt: link.revokedAt?.toISOString() ?? null,
    autoDisabled: link.autoDisabled,
    createdAt: link.createdAt.toISOString(),
    url: `${webOrigin}/s/${link.token}`,
  };
}

/**
 * Share links: creation/revocation by a workspace member, and the read path the
 * public `/s/:token` viewer uses (B15 brief §1, F-501–F-504).
 *
 * Live (unrevoked, unexpired, under any view cap) is checked in one place —
 * {@link resolve} — so the viewer, the comment/approve routes and the
 * report-abuse form all fail the same way for the same reasons.
 */
@Injectable()
export class ShareLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: ShareSessionSigner,
    private readonly audit: CommonAuditService,
  ) {}

  async create(
    workspaceId: string,
    userId: string,
    projectId: string,
    input: CreateShareLinkDto,
    webOrigin: string,
  ): Promise<ShareLinkView> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (project === null) {
      throw new AppException(SHARE_ERRORS.notFound, "Project not found.", HttpStatus.NOT_FOUND);
    }

    const passwordHash =
      input.password === undefined ? null : await this.passwords.hash(input.password);

    const link = await this.prisma.shareLink.create({
      data: {
        id: ulid(),
        projectId,
        token: generateShareToken(),
        scope: input.scope,
        passwordHash,
        expiresAt: input.expiresAt === undefined ? null : new Date(input.expiresAt),
        maxViews: input.maxViews ?? null,
        clientTag: input.clientTag ?? null,
        createdBy: userId,
      },
    });

    await this.audit.record({
      action: "share.link.created",
      resource: "share_link",
      resourceId: link.id,
      actorId: userId,
      workspaceId,
      data: { projectId, scope: link.scope, hasPassword: passwordHash !== null },
    });

    return toView(link, webOrigin);
  }

  async list(workspaceId: string, projectId: string, webOrigin: string): Promise<ShareLinkView[]> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (project === null) {
      throw new AppException(SHARE_ERRORS.notFound, "Project not found.", HttpStatus.NOT_FOUND);
    }
    const links = await this.prisma.shareLink.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    return links.map((link) => toView(link, webOrigin));
  }

  /** Owner or admin one-click disable (F-504). */
  async revoke(
    workspaceId: string,
    userId: string,
    projectId: string,
    shareLinkId: string,
  ): Promise<void> {
    const link = await this.prisma.shareLink.findFirst({
      where: { id: shareLinkId, projectId, project: { workspaceId, deletedAt: null } },
    });
    if (link === null) {
      throw new AppException(SHARE_ERRORS.notFound, "Share link not found.", HttpStatus.NOT_FOUND);
    }
    if (link.revokedAt !== null) return;

    await this.prisma.shareLink.update({
      where: { id: shareLinkId },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      action: "share.link.revoked",
      resource: "share_link",
      resourceId: shareLinkId,
      actorId: userId,
      workspaceId,
      data: { projectId },
    });
  }

  /**
   * The one liveness check every public route runs first: not revoked, not
   * expired, and under any view cap (view cap is only *counted* here — the
   * increment happens in {@link recordView}, once per page load, not once per
   * API call, so opening the comments panel does not also burn a view).
   */
  async resolve(token: string, sessionCookie: string | undefined): Promise<ResolvedShareLink> {
    const link = await this.prisma.shareLink.findUnique({ where: { token } });
    if (link === null) {
      throw new AppException(
        SHARE_ERRORS.notFound,
        "This link does not exist.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (link.revokedAt !== null) {
      throw new AppException(SHARE_ERRORS.revoked, "This link has been disabled.", HttpStatus.GONE);
    }
    if (link.expiresAt !== null && link.expiresAt.getTime() < Date.now()) {
      throw new AppException(SHARE_ERRORS.expired, "This link has expired.", HttpStatus.GONE);
    }
    if (link.maxViews !== null && link.viewCount >= link.maxViews) {
      throw new AppException(
        SHARE_ERRORS.viewLimitReached,
        "This link has reached its view limit.",
        HttpStatus.GONE,
      );
    }

    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: link.projectId },
      select: {
        id: true,
        title: true,
        aspect: true,
        reviewStatus: true,
        workspaceId: true,
        createdBy: true,
      },
    });

    const requiresPassword = link.passwordHash !== null;
    const unlocked = !requiresPassword || this.sessions.verify(sessionCookie, token);

    return { shareLink: link, project, requiresPassword, unlocked };
  }

  /** Called once per page load, after {@link resolve} says the link is live. */
  async recordView(shareLinkId: string): Promise<void> {
    await this.prisma.shareLink.update({
      where: { id: shareLinkId },
      data: { viewCount: { increment: 1 } },
    });
  }

  /** Verifies the password and, on success, hands back a session cookie value. */
  async unlock(token: string, password: string): Promise<string> {
    const link = await this.prisma.shareLink.findUnique({ where: { token } });
    if (link === null || link.revokedAt !== null) {
      throw new AppException(
        SHARE_ERRORS.notFound,
        "This link does not exist.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (link.passwordHash === null) {
      throw new AppException(
        SHARE_ERRORS.passwordRequired,
        "This link has no password.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const ok = await this.passwords.verify(link.passwordHash, password);
    if (!ok) {
      throw new AppException(
        SHARE_ERRORS.passwordIncorrect,
        "Incorrect password.",
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.sessions.sign(token, Date.now() + SHARE_SESSION_TTL_SECONDS * 1000);
  }

  /** Asserts the link's scope allows at least `required` (view < comment < approve). */
  assertScope(scope: $Enums.ShareLinkScope, required: ShareScope): void {
    const rank: Record<ShareScope, number> = { view: 0, comment: 1, approve: 2 };
    if (rank[scope] < rank[required]) {
      throw new AppException(
        SHARE_ERRORS.scopeForbidden,
        `This link does not allow ${required}.`,
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** F-501/§2: approve or request-changes, only for `scope: approve` links. */
  async decide(
    token: string,
    decision: "approved" | "changes_requested",
  ): Promise<{ readonly projectId: string; readonly reviewStatus: string }> {
    const { shareLink, project } = await this.resolve(token, undefined);
    this.assertScope(shareLink.scope, "approve");

    await this.prisma.project.update({
      where: { id: project.id },
      data: { reviewStatus: decision },
    });

    await this.audit.record({
      action: "share.link.decision",
      resource: "project",
      resourceId: project.id,
      actorKind: "guest",
      workspaceId: project.workspaceId,
      data: { shareLinkId: shareLink.id, decision },
    });

    return { projectId: project.id, reviewStatus: decision };
  }

  /**
   * F-504: report-abuse intake plus the auto-disable rule — "automatic disable
   * after N reports pending review". `resolvedAt IS NULL` is what "pending"
   * means; a dismissed report never re-triggers this.
   */
  async report(
    token: string,
    input: { category: $Enums.ShareReportCategory; reporterContact?: string },
  ): Promise<{ readonly id: string; readonly dueAt: string }> {
    const link = await this.prisma.shareLink.findUnique({ where: { token } });
    if (link === null) {
      throw new AppException(
        SHARE_ERRORS.notFound,
        "This link does not exist.",
        HttpStatus.NOT_FOUND,
      );
    }

    const hours = SHARE_REPORT_SLA_HOURS[input.category === "ncii" ? "ncii" : "other"];
    const dueAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    const report = await this.prisma.$transaction(async (tx) => {
      const created = await tx.shareReport.create({
        data: {
          id: ulid(),
          shareLinkId: link.id,
          reporterContact: input.reporterContact ?? null,
          category: input.category,
          dueAt,
        },
      });

      const pending = await tx.shareReport.count({
        where: { shareLinkId: link.id, resolvedAt: null },
      });

      await tx.shareLink.update({
        where: { id: link.id },
        data: {
          reportCount: { increment: 1 },
          ...(pending >= SHARE_AUTO_DISABLE_REPORT_THRESHOLD && link.revokedAt === null
            ? { revokedAt: new Date(), autoDisabled: true }
            : {}),
        },
      });

      return created;
    });

    await this.audit.record({
      action: "share.link.reported",
      resource: "share_report",
      resourceId: report.id,
      actorKind: "guest",
      data: { shareLinkId: link.id, category: input.category },
    });

    return { id: report.id, dueAt: report.dueAt.toISOString() };
  }
}
