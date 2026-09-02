import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { FOLDER_MAX_DEPTH, PROJECT_ERRORS } from "./projects.constants.js";
import { AppException, PrismaService } from "../common/index.js";

import type { Folder, Prisma } from "@prisma/client";

export interface FolderView {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly position: number;
  readonly projectCount: number;
  readonly createdAt: string;
}

export interface CreateFolderInput {
  readonly name: string;
  readonly parentId?: string;
  readonly position?: number;
}

export interface UpdateFolderInput {
  readonly name?: string;
  readonly parentId?: string | null;
  readonly position?: number;
}

/**
 * Project folders.
 *
 * 06-data-model.md gives `projects.folder_id` but no table, so A03 left the
 * column without a foreign key and A06 converts it. The tree is deliberately
 * shallow — {@link FOLDER_MAX_DEPTH} levels — and two rules keep it honest:
 *
 * * **A folder never leaves its workspace.** Every read and write is filtered by
 *   `workspaceId`, so a parent id from another tenant is a 404 (T5).
 * * **A folder is never its own ancestor.** Re-parenting walks up from the
 *   proposed parent and refuses if it meets the folder being moved. The database
 *   cannot express that, so the service must, and a cycle would make every
 *   depth-first walk in the product hang.
 */
@Injectable()
export class FoldersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string): Promise<FolderView[]> {
    const rows = await this.prisma.folder.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: [{ position: "asc" }, { name: "asc" }],
      include: { _count: { select: { projects: true } } },
    });
    return rows.map((row) => toFolderView(row, row._count.projects));
  }

  async create(workspaceId: string, userId: string, input: CreateFolderInput): Promise<FolderView> {
    if (input.parentId !== undefined) {
      const depth = await this.depthOf(workspaceId, input.parentId);
      if (depth + 1 >= FOLDER_MAX_DEPTH) {
        throw new AppException(
          PROJECT_ERRORS.folderCycle,
          `Folders may nest ${String(FOLDER_MAX_DEPTH)} deep.`,
          HttpStatus.CONFLICT,
          { maxDepth: FOLDER_MAX_DEPTH },
        );
      }
    }

    const folder = await this.prisma.folder.create({
      data: {
        id: ulid(),
        workspaceId,
        name: input.name,
        parentId: input.parentId ?? null,
        position: input.position ?? 0,
        createdBy: userId,
      },
    });
    return toFolderView(folder, 0);
  }

  async update(
    workspaceId: string,
    folderId: string,
    input: UpdateFolderInput,
  ): Promise<FolderView> {
    await this.require(workspaceId, folderId);

    if (input.parentId !== undefined && input.parentId !== null) {
      if (input.parentId === folderId) throw cycle(folderId);
      const ancestors = await this.ancestorsOf(workspaceId, input.parentId);
      if (ancestors.includes(folderId)) throw cycle(folderId);
    }

    const data: Prisma.FolderUncheckedUpdateInput = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.position === undefined ? {} : { position: input.position }),
    };
    await this.prisma.folder.update({ where: { id: folderId }, data });
    return this.get(workspaceId, folderId);
  }

  async get(workspaceId: string, folderId: string): Promise<FolderView> {
    const folder = await this.prisma.folder.findFirst({
      where: { id: folderId, workspaceId, deletedAt: null },
      include: { _count: { select: { projects: true } } },
    });
    if (folder === null) throw notFound(folderId);
    return toFolderView(folder, folder._count.projects);
  }

  /**
   * Soft delete.
   *
   * Refused while projects or child folders are still in it: a folder is
   * navigation, and silently orphaning what is inside one is how a customer
   * loses work they can still see in a list.
   */
  async softDelete(workspaceId: string, folderId: string): Promise<{ id: string }> {
    await this.require(workspaceId, folderId);
    const [projects, children] = await Promise.all([
      this.prisma.project.count({ where: { folderId, deletedAt: null } }),
      this.prisma.folder.count({ where: { parentId: folderId, deletedAt: null } }),
    ]);
    if (projects > 0 || children > 0) {
      throw new AppException(
        PROJECT_ERRORS.folderNotEmpty,
        "Move or delete what is in the folder first.",
        HttpStatus.CONFLICT,
        { projects, folders: children },
      );
    }

    await this.prisma.folder.update({
      where: { id: folderId },
      data: { deletedAt: new Date() },
    });
    return { id: folderId };
  }

  private async require(workspaceId: string, folderId: string): Promise<Folder> {
    const folder = await this.prisma.folder.findFirst({
      where: { id: folderId, workspaceId, deletedAt: null },
    });
    if (folder === null) throw notFound(folderId);
    return folder;
  }

  /** Ids from `folderId` up to the root, nearest first. Bounded by the depth cap. */
  private async ancestorsOf(workspaceId: string, folderId: string): Promise<string[]> {
    const chain: string[] = [];
    let current: string | null = folderId;
    for (let step = 0; step < FOLDER_MAX_DEPTH && current !== null; step += 1) {
      const folder: Folder = await this.require(workspaceId, current);
      chain.push(folder.id);
      current = folder.parentId;
    }
    return chain;
  }

  private async depthOf(workspaceId: string, folderId: string): Promise<number> {
    return (await this.ancestorsOf(workspaceId, folderId)).length;
  }
}

function toFolderView(folder: Folder, projectCount: number): FolderView {
  return {
    id: folder.id,
    workspaceId: folder.workspaceId,
    name: folder.name,
    parentId: folder.parentId,
    position: folder.position,
    projectCount,
    createdAt: folder.createdAt.toISOString(),
  };
}

function notFound(folderId: string): AppException {
  return new AppException(PROJECT_ERRORS.folderNotFound, "No such folder.", HttpStatus.NOT_FOUND, {
    folderId,
  });
}

function cycle(folderId: string): AppException {
  return new AppException(
    PROJECT_ERRORS.folderCycle,
    "A folder cannot be moved inside itself.",
    HttpStatus.CONFLICT,
    { folderId },
  );
}
