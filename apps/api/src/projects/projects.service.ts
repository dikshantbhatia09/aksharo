import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { addDays, mediaLimitsFor } from "./plan-limits.js";
import {
  PROJECT_BATCH_MAX,
  PROJECT_ERRORS,
  PROJECTS_MAX_PAGE_SIZE,
  PROJECTS_PAGE_SIZE,
} from "./projects.constants.js";
import { AppException, PrismaService } from "../common/index.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { PROJECT_ASPECTS, PROJECT_STATUSES } from "./projects.dto.js";
import type { $Enums, Prisma, Project } from "@prisma/client";

export type ProjectAspect = (typeof PROJECT_ASPECTS)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface ProjectView {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly folderId: string | null;
  readonly clientTag: string | null;
  readonly sourceLanguage: string | null;
  readonly scripts: readonly string[];
  readonly aspect: ProjectAspect;
  readonly status: ProjectStatus;
  readonly thumbnailKey: string | null;
  readonly durationMs: number | null;
  readonly mediaCount: number;
  readonly lastActivityAt: string;
  readonly retentionUntil: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface CreateProjectInput {
  readonly title: string;
  readonly folderId?: string;
  readonly clientTag?: string;
  readonly aspect?: ProjectAspect;
  readonly sourceLanguage?: string;
}

export interface UpdateProjectInput {
  readonly title?: string;
  readonly folderId?: string | null;
  readonly clientTag?: string | null;
  readonly aspect?: ProjectAspect;
  readonly sourceLanguage?: string | null;
  readonly status?: ProjectStatus;
}

export interface ListProjectsInput {
  readonly q?: string;
  readonly status?: ProjectStatus;
  /** A folder id, or `"root"` for projects that are in no folder. */
  readonly folder?: string;
  readonly clientTag?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * `CONTRACTS §2` spells an aspect `"9:16"`; the Prisma enum member is `r9x16`
 * because an identifier cannot start with a digit or contain a colon. The
 * `@map` in the schema means the *database* stores `"9:16"`, so this pair of
 * functions is the only place the two spellings meet.
 */
const ASPECT_TO_ENUM: Readonly<Record<ProjectAspect, $Enums.Aspect>> = {
  "9:16": "r9x16",
  "16:9": "r16x9",
  "1:1": "r1x1",
  "4:5": "r4x5",
};

const ENUM_TO_ASPECT: Readonly<Record<$Enums.Aspect, ProjectAspect>> = {
  r9x16: "9:16",
  r16x9: "16:9",
  r1x1: "1:1",
  r4x5: "4:5",
};

/**
 * Projects: the unit of work everything else in the product hangs off.
 *
 * Two rules run through every method here, and they are the reason the service
 * exists rather than the controller talking to Prisma:
 *
 * 1. **Every query is filtered by `workspaceId`** — never by id alone. The
 *    workspace comes from the access token (`WorkspaceMemberGuard` has already
 *    proved the caller is a live member of it), so a project id belonging to
 *    another tenant simply matches nothing and answers **404**, not 403. That is
 *    THREAT-MODEL T5: a 403 would confirm the id exists.
 * 2. **Deletes are soft.** `deleted_at` is set and the row stays, because a
 *    project owns transcripts, an EDG document, exports and jobs, and D47's
 *    retention sweep — not a DELETE cascade — is what eventually removes them.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
  ) {}

  async create(
    workspaceId: string,
    userId: string,
    input: CreateProjectInput,
  ): Promise<ProjectView> {
    if (input.folderId !== undefined) await this.assertFolder(workspaceId, input.folderId);

    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(workspaceId));
    const project = await this.prisma.project.create({
      data: this.createData(workspaceId, userId, input, limits.retentionDays),
    });
    return toProjectView(project, 0);
  }

  /**
   * `POST /projects/batch`.
   *
   * One transaction, so a batch either lands whole or not at all: the caller is
   * usually a folder drop and a half-created batch is worse than none.
   */
  async batchCreate(
    workspaceId: string,
    userId: string,
    input: {
      readonly projects: readonly CreateProjectInput[];
      readonly folderId?: string;
      readonly clientTag?: string;
    },
  ): Promise<ProjectView[]> {
    if (input.projects.length > PROJECT_BATCH_MAX) {
      throw new AppException(
        PROJECT_ERRORS.batchTooLarge,
        `A batch may create at most ${String(PROJECT_BATCH_MAX)} projects.`,
        HttpStatus.BAD_REQUEST,
        { maximum: PROJECT_BATCH_MAX, requested: input.projects.length },
      );
    }

    const folderIds = new Set<string>();
    if (input.folderId !== undefined) folderIds.add(input.folderId);
    for (const project of input.projects) {
      if (project.folderId !== undefined) folderIds.add(project.folderId);
    }
    for (const folderId of folderIds) await this.assertFolder(workspaceId, folderId);

    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(workspaceId));
    const rows = input.projects.map((project) =>
      this.createData(
        workspaceId,
        userId,
        {
          ...project,
          ...(project.folderId === undefined && input.folderId !== undefined
            ? { folderId: input.folderId }
            : {}),
          ...(project.clientTag === undefined && input.clientTag !== undefined
            ? { clientTag: input.clientTag }
            : {}),
        },
        limits.retentionDays,
      ),
    );

    const created = await this.prisma.withTransaction(async (tx) => {
      const out: Project[] = [];
      for (const data of rows) out.push(await tx.project.create({ data }));
      return out;
    });
    return created.map((project) => toProjectView(project, 0));
  }

  async list(workspaceId: string, input: ListProjectsInput): Promise<Page<ProjectView>> {
    const take = clampLimit(input.limit);
    const where: Prisma.ProjectWhereInput = {
      workspaceId,
      deletedAt: null,
      ...(input.q === undefined ? {} : { title: { contains: input.q, mode: "insensitive" } }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.clientTag === undefined ? {} : { clientTag: input.clientTag }),
      ...(input.folder === undefined
        ? {}
        : { folderId: input.folder === "root" ? null : input.folder }),
    };

    const rows = await this.prisma.project.findMany({
      where,
      // ULIDs sort lexicographically by creation time, so the id alone is a
      // stable cursor: no (timestamp, id) tuple and no ties to break.
      orderBy: { id: "desc" },
      ...(input.cursor === undefined ? {} : { cursor: { id: input.cursor }, skip: 1 }),
      take: take + 1,
      include: { _count: { select: { mediaAssets: true } } },
    });

    const items = rows.slice(0, take);
    const nextCursor = rows.length > take ? (items[items.length - 1]?.id ?? null) : null;
    return {
      items: items.map((row) => toProjectView(row, row._count.mediaAssets)),
      nextCursor,
    };
  }

  /** @throws AppException 404 when it is missing, deleted, or another tenant's. */
  async requireProject(workspaceId: string, projectId: string): Promise<Project> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
    });
    if (project === null) {
      throw new AppException(PROJECT_ERRORS.notFound, "No such project.", HttpStatus.NOT_FOUND, {
        projectId,
      });
    }
    return project;
  }

  async get(workspaceId: string, projectId: string): Promise<ProjectView> {
    await this.requireProject(workspaceId, projectId);
    const project = await this.prisma.project.findFirstOrThrow({
      where: { id: projectId, workspaceId, deletedAt: null },
      include: { _count: { select: { mediaAssets: true } } },
    });
    return toProjectView(project, project._count.mediaAssets);
  }

  async update(
    workspaceId: string,
    projectId: string,
    input: UpdateProjectInput,
  ): Promise<ProjectView> {
    await this.requireProject(workspaceId, projectId);
    if (input.folderId !== undefined && input.folderId !== null) {
      await this.assertFolder(workspaceId, input.folderId);
    }

    const data: Prisma.ProjectUncheckedUpdateInput = {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      ...(input.clientTag === undefined ? {} : { clientTag: input.clientTag }),
      ...(input.sourceLanguage === undefined ? {} : { sourceLanguage: input.sourceLanguage }),
      ...(input.aspect === undefined ? {} : { aspect: ASPECT_TO_ENUM[input.aspect] }),
      ...(input.status === undefined ? {} : { status: input.status }),
      lastActivityAt: new Date(),
    };
    await this.prisma.project.update({ where: { id: projectId }, data });
    return this.get(workspaceId, projectId);
  }

  /**
   * Soft delete.
   *
   * The objects are not touched here: `retentionUntil` already says when the
   * bytes go, and `purgeDueMedia()` is the one place that deletes them. A
   * "delete" that removed the objects synchronously would make an accidental
   * click unrecoverable and would put an S3 round trip inside a request.
   */
  async softDelete(workspaceId: string, projectId: string): Promise<{ id: string }> {
    await this.requireProject(workspaceId, projectId);
    await this.prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: new Date(), status: "archived" },
    });
    return { id: projectId };
  }

  /** Bump `last_activity_at`; called whenever media or a job touches the project. */
  async touch(projectId: string, at: Date = new Date()): Promise<void> {
    await this.prisma.project.updateMany({
      where: { id: projectId },
      data: { lastActivityAt: at },
    });
  }

  /** The folder must exist, be live, and belong to this workspace. */
  private async assertFolder(workspaceId: string, folderId: string): Promise<void> {
    const folder = await this.prisma.folder.findFirst({
      where: { id: folderId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (folder === null) {
      throw new AppException(
        PROJECT_ERRORS.folderNotFound,
        "No such folder.",
        HttpStatus.NOT_FOUND,
        { folderId },
      );
    }
  }

  private createData(
    workspaceId: string,
    userId: string,
    input: CreateProjectInput,
    retentionDays: number,
  ): Prisma.ProjectUncheckedCreateInput {
    const now = new Date();
    return {
      id: ulid(),
      workspaceId,
      title: input.title,
      folderId: input.folderId ?? null,
      clientTag: input.clientTag ?? null,
      sourceLanguage: input.sourceLanguage ?? null,
      aspect: ASPECT_TO_ENUM[input.aspect ?? "9:16"],
      status: "draft",
      createdBy: userId,
      lastActivityAt: now,
      // D47: the plan's retention window opens the moment the project does, and
      // every upload pushes it out again (`MediaService.complete`).
      retentionUntil: addDays(now, retentionDays),
    };
  }
}

export function toProjectView(project: Project, mediaCount: number): ProjectView {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    title: project.title,
    folderId: project.folderId,
    clientTag: project.clientTag,
    sourceLanguage: project.sourceLanguage,
    scripts: project.scripts,
    aspect: ENUM_TO_ASPECT[project.aspect],
    status: project.status,
    thumbnailKey: project.thumbnailKey,
    durationMs: project.durationMs,
    mediaCount,
    lastActivityAt: project.lastActivityAt.toISOString(),
    retentionUntil: project.retentionUntil?.toISOString() ?? null,
    createdBy: project.createdBy,
    createdAt: project.createdAt.toISOString(),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return PROJECTS_PAGE_SIZE;
  return Math.min(PROJECTS_MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}
