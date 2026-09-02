import { HttpStatus, Injectable } from "@nestjs/common";

import { TEAMS_AUDIT_ACTIONS } from "./teams.constants.js";
import { AppException, ERROR_CODES, PrismaService } from "../../common/index.js";
import { AuditService } from "../../users/audit.service.js";

import type { RequestContextInfo } from "../../users/profile.service.js";

export interface ClientTagView {
  readonly tag: string;
  readonly projectCount: number;
  readonly folderCount: number;
}

/**
 * Client tags on projects and folders (04 §Plans: "client tags ... per-client
 * share links" -- the tags themselves, plus the filter; per-client share links
 * are B15's).
 *
 * A tag is free text on the row (`projects.client_tag` since A06,
 * `folders.client_tag` new in this work package's migration) — there is no
 * `clients` table in 06 to foreign-key to, so "the list of client tags" is
 * `DISTINCT client_tag` over both, not a lookup.
 */
@Injectable()
export class ClientTagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every tag in use in this workspace, with how many projects/folders carry it. */
  async list(workspaceId: string): Promise<ClientTagView[]> {
    const [projects, folders] = await Promise.all([
      this.prisma.project.groupBy({
        by: ["clientTag"],
        where: { workspaceId, deletedAt: null, clientTag: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.folder.groupBy({
        by: ["clientTag"],
        where: { workspaceId, deletedAt: null, clientTag: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const byTag = new Map<string, { projectCount: number; folderCount: number }>();
    for (const row of projects) {
      if (row.clientTag === null) continue;
      const entry = byTag.get(row.clientTag) ?? { projectCount: 0, folderCount: 0 };
      entry.projectCount = row._count._all;
      byTag.set(row.clientTag, entry);
    }
    for (const row of folders) {
      if (row.clientTag === null) continue;
      const entry = byTag.get(row.clientTag) ?? { projectCount: 0, folderCount: 0 };
      entry.folderCount = row._count._all;
      byTag.set(row.clientTag, entry);
    }

    return [...byTag.entries()]
      .map(([tag, counts]) => ({ tag, ...counts }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }

  async setProjectTag(
    workspaceId: string,
    projectId: string,
    tag: string | null,
    actorId: string,
    context: RequestContextInfo,
  ): Promise<{ id: string; clientTag: string | null }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (project === null) {
      throw new AppException(ERROR_CODES.notFound, "No such project.", HttpStatus.NOT_FOUND);
    }

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { clientTag: tag },
      select: { id: true, clientTag: true },
    });

    await this.audit.record({
      action: TEAMS_AUDIT_ACTIONS.clientTagSet,
      resource: "project",
      resourceId: projectId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { clientTag: tag },
    });

    return updated;
  }

  async setFolderTag(
    workspaceId: string,
    folderId: string,
    tag: string | null,
    actorId: string,
    context: RequestContextInfo,
  ): Promise<{ id: string; clientTag: string | null }> {
    const folder = await this.prisma.folder.findFirst({
      where: { id: folderId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (folder === null) {
      throw new AppException(ERROR_CODES.notFound, "No such folder.", HttpStatus.NOT_FOUND);
    }

    const updated = await this.prisma.folder.update({
      where: { id: folderId },
      data: { clientTag: tag },
      select: { id: true, clientTag: true },
    });

    await this.audit.record({
      action: TEAMS_AUDIT_ACTIONS.clientTagSet,
      resource: "folder",
      resourceId: folderId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { clientTag: tag },
    });

    return updated;
  }

  /** `GET /workspaces/{id}/projects?clientTag=` -- the filter itself. */
  async projectsForTag(workspaceId: string, tag: string): Promise<{ id: string; title: string }[]> {
    return this.prisma.project.findMany({
      where: { workspaceId, deletedAt: null, clientTag: tag },
      select: { id: true, title: true },
      orderBy: { lastActivityAt: "desc" },
    });
  }
}
