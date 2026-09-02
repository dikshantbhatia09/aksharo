import { beforeEach, describe, expect, it, vi } from "vitest";

import { FoldersService } from "./folders.service.js";
import { callArg } from "../../test/mock-args.js";

import type { PrismaService } from "../common/index.js";
import type { Folder } from "@prisma/client";

const WORKSPACE = "01JBZ0Q4T7R8N4H1V0J9K2M3P5";
const USER = "01JBZ0Q4T7R8N4H1V0J9K2M3P6";
const ROOT = "01JBZ0Q4T7R8N4H1V0J9K2M3PA";
const CHILD = "01JBZ0Q4T7R8N4H1V0J9K2M3PB";
const GRANDCHILD = "01JBZ0Q4T7R8N4H1V0J9K2M3PC";

function folderRow(id: string, parentId: string | null = null): Folder {
  return {
    id,
    workspaceId: WORKSPACE,
    name: `folder-${id.slice(-2)}`,
    parentId,
    position: 0,
    createdBy: USER,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    deletedAt: null,
  } as Folder;
}

function makeService(tree: Record<string, Folder> = {}) {
  const prisma = {
    folder: {
      findMany: vi.fn(async () => []),
      // The service reads this both bare (`require`) and with a `_count`
      // (`get`), so the fake always carries the count.
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const folder = tree[where.id];
        return folder === undefined ? null : { ...folder, _count: { projects: 0 } };
      }),
      create: vi.fn(async ({ data }: { data: Folder }) => ({ ...folderRow(data.id), ...data })),
      update: vi.fn(async () => folderRow(ROOT)),
      count: vi.fn(async () => 0),
    },
    project: { count: vi.fn(async () => 0) },
  };
  const service = new FoldersService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe("FoldersService.list", () => {
  it("returns live folders in position then name order", async () => {
    const { service, prisma } = makeService();
    prisma.folder.findMany.mockResolvedValueOnce([
      { ...folderRow(ROOT), _count: { projects: 4 } },
    ] as never);
    const folders = await service.list(WORKSPACE);
    expect(folders[0]?.projectCount).toBe(4);
    expect(callArg(prisma.folder.findMany, 0, 0)).toMatchObject({
      where: { workspaceId: WORKSPACE, deletedAt: null },
      orderBy: [{ position: "asc" }, { name: "asc" }],
    });
  });
});

describe("FoldersService.create", () => {
  let tree: Record<string, Folder>;

  beforeEach(() => {
    tree = { [ROOT]: folderRow(ROOT) };
  });

  it("creates a top-level folder", async () => {
    const { service, prisma } = makeService(tree);
    await service.create(WORKSPACE, USER, { name: "Clients" });
    const data = callArg(prisma.folder.create, 0, 0).data as Folder;
    expect(data.workspaceId).toBe(WORKSPACE);
    expect(data.parentId).toBeNull();
  });

  it("refuses a parent from another workspace", async () => {
    const { service } = makeService({});
    await expect(
      service.create(WORKSPACE, USER, { name: "x", parentId: ROOT }),
    ).rejects.toMatchObject({ code: "project/folder_not_found" });
  });

  it("refuses nesting past the depth cap", async () => {
    // A chain of eight, so a ninth would exceed FOLDER_MAX_DEPTH.
    const chain: Record<string, Folder> = {};
    let parent: string | null = null;
    const ids = Array.from(
      { length: 8 },
      (_unused, index) => `01JBZ0Q4T7R8N4H1V0J9K2M3${String(index)}0`,
    );
    for (const id of ids) {
      chain[id] = folderRow(id, parent);
      parent = id;
    }
    const { service } = makeService(chain);
    await expect(
      service.create(WORKSPACE, USER, { name: "too deep", parentId: ids[7] as string }),
    ).rejects.toMatchObject({ code: "project/folder_cycle" });
  });
});

describe("FoldersService.update", () => {
  it("refuses to move a folder into itself", async () => {
    const { service } = makeService({ [ROOT]: folderRow(ROOT) });
    await expect(service.update(WORKSPACE, ROOT, { parentId: ROOT })).rejects.toMatchObject({
      code: "project/folder_cycle",
    });
  });

  it("refuses to move a folder into its own descendant", async () => {
    const tree = {
      [ROOT]: folderRow(ROOT),
      [CHILD]: folderRow(CHILD, ROOT),
      [GRANDCHILD]: folderRow(GRANDCHILD, CHILD),
    };
    const { service } = makeService(tree);
    await expect(service.update(WORKSPACE, ROOT, { parentId: GRANDCHILD })).rejects.toMatchObject({
      code: "project/folder_cycle",
    });
  });

  it("allows a legitimate move and writes only what changed", async () => {
    const tree = { [ROOT]: folderRow(ROOT), [CHILD]: folderRow(CHILD) };
    const { service, prisma } = makeService(tree);
    await service.update(WORKSPACE, CHILD, { parentId: ROOT, name: "Renamed" });
    const data = callArg(prisma.folder.update, 0, 0).data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["name", "parentId"]);
  });
});

describe("FoldersService.softDelete", () => {
  it("refuses while projects are still filed in it", async () => {
    const { service, prisma } = makeService({ [ROOT]: folderRow(ROOT) });
    prisma.project.count.mockResolvedValueOnce(2 as never);
    await expect(service.softDelete(WORKSPACE, ROOT)).rejects.toMatchObject({
      code: "project/folder_not_empty",
    });
  });

  it("refuses while child folders remain", async () => {
    const { service, prisma } = makeService({ [ROOT]: folderRow(ROOT) });
    prisma.folder.count.mockResolvedValueOnce(1 as never);
    await expect(service.softDelete(WORKSPACE, ROOT)).rejects.toMatchObject({
      code: "project/folder_not_empty",
    });
  });

  it("soft deletes an empty folder", async () => {
    const { service, prisma } = makeService({ [ROOT]: folderRow(ROOT) });
    await expect(service.softDelete(WORKSPACE, ROOT)).resolves.toEqual({ id: ROOT });
    const data = callArg(prisma.folder.update, 0, 0).data as Record<string, unknown>;
    expect(data["deletedAt"]).toBeInstanceOf(Date);
  });

  it("is a 404 for another tenant's folder", async () => {
    const { service } = makeService({});
    await expect(service.softDelete(WORKSPACE, ROOT)).rejects.toMatchObject({
      code: "project/folder_not_found",
      httpStatus: 404,
    });
  });
});
