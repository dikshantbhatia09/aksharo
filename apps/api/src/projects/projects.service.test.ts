import { beforeEach, describe, expect, it, vi } from "vitest";

import { addDays, derivedPurgeAt, mediaLimitsFor, rawPurgeAt } from "./plan-limits.js";
import { PROJECT_BATCH_MAX, RAW_RETENTION_DAYS } from "./projects.constants.js";
import { ProjectsService, toProjectView } from "./projects.service.js";
import { callArg } from "../../test/mock-args.js";

import type { ObjectStore, PrismaService } from "../common/index.js";
import type { EntitlementService, EntitlementView } from "../workspaces/entitlement.service.js";
import type { Project } from "@prisma/client";

const WORKSPACE = "01JBZ0Q4T7R8N4H1V0J9K2M3P5";
const OTHER_WORKSPACE = "01JBZ0Q4T7R8N4H1V0J9K2M3PA";
const USER = "01JBZ0Q4T7R8N4H1V0J9K2M3P6";
const PROJECT = "01JBZ0Q4T7R8N4H1V0J9K2M3P7";
const FOLDER = "01JBZ0Q4T7R8N4H1V0J9K2M3P8";

function projectRow(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT,
    workspaceId: WORKSPACE,
    title: "A project",
    folderId: null,
    batchId: null,
    clientTag: null,
    sourceLanguage: null,
    scripts: [],
    aspect: "r9x16",
    status: "draft",
    reviewStatus: "none",
    thumbnailKey: null,
    durationMs: null,
    lastActivityAt: new Date("2026-09-02T00:00:00.000Z"),
    retentionUntil: null,
    createdBy: USER,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  } as Project;
}

function entitlement(values: Record<string, unknown> = {}): EntitlementView {
  return {
    workspaceId: WORKSPACE,
    planKey: "free",
    planName: "Free",
    creditsPerMonthTenths: 300,
    seatsIncluded: 0,
    seatsUsed: 1,
    entitlements: {
      maxFileBytes: 500 * 1024 * 1024,
      maxDurationMs: 1_200_000,
      retentionDays: 7,
      ...values,
    },
    computedAt: new Date().toISOString(),
  };
}

function makeService() {
  const prisma = {
    project: {
      create: vi.fn(async ({ data }: { data: Project }) => projectRow(data)),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => projectRow()),
      findFirstOrThrow: vi.fn(async () => ({ ...projectRow(), _count: { mediaAssets: 2 } })),
      update: vi.fn(async () => projectRow()),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    folder: { findFirst: vi.fn(async () => ({ id: FOLDER })) },
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ project: prisma.project }),
    ),
  };
  const entitlements = { forWorkspace: vi.fn(async () => entitlement()) };
  // FIX-05: the service presigns project thumbnails through DERIVED_STORE.
  const derived = { presignGet: vi.fn(async () => "https://derived.test/thumb.jpg?sig=x") };
  const service = new ProjectsService(
    prisma as unknown as PrismaService,
    entitlements as unknown as EntitlementService,
    derived as unknown as ObjectStore,
  );
  return { service, prisma, entitlements, derived };
}

describe("plan limits", () => {
  it("reads the three numbers off the entitlement", () => {
    const limits = mediaLimitsFor(entitlement());
    expect(limits).toMatchObject({
      maxFileBytes: 500 * 1024 * 1024,
      maxDurationMs: 1_200_000,
      retentionDays: 7,
      planKey: "free",
    });
  });

  it("falls back to the Free plan's numbers rather than to unlimited", () => {
    const limits = mediaLimitsFor(
      entitlement({ maxFileBytes: "lots", maxDurationMs: -1, retentionDays: null }),
    );
    expect(limits.maxFileBytes).toBe(500 * 1024 * 1024);
    expect(limits.maxDurationMs).toBe(20 * 60 * 1000);
    expect(limits.retentionDays).toBe(7);
  });

  it("computes the two purge instants from the upload time (D47)", () => {
    const uploadedAt = new Date("2026-09-02T00:00:00.000Z");
    expect(rawPurgeAt(uploadedAt)).toEqual(addDays(uploadedAt, RAW_RETENTION_DAYS));
    expect(derivedPurgeAt(uploadedAt, mediaLimitsFor(entitlement({ retentionDays: 30 })))).toEqual(
      addDays(uploadedAt, 30),
    );
  });
});

describe("ProjectsService.create", () => {
  let harness: ReturnType<typeof makeService>;

  beforeEach(() => {
    harness = makeService();
  });

  it("opens the retention window at the plan's length", async () => {
    await harness.service.create(WORKSPACE, USER, { title: "Diwali reel" });
    const data = callArg(harness.prisma.project.create, 0, 0).data as Project;
    expect(data.workspaceId).toBe(WORKSPACE);
    expect(data.createdBy).toBe(USER);
    expect(data.retentionUntil).toBeInstanceOf(Date);
    const days =
      ((data.retentionUntil as Date).getTime() - (data.lastActivityAt as Date).getTime()) /
      86_400_000;
    expect(Math.round(days)).toBe(7);
  });

  it("maps the contract's aspect spelling onto the Prisma enum member", async () => {
    await harness.service.create(WORKSPACE, USER, { title: "wide", aspect: "16:9" });
    const data = callArg(harness.prisma.project.create, 0, 0).data as Project;
    expect(data.aspect).toBe("r16x9");
  });

  it("refuses a folder that is not this workspace's", async () => {
    harness.prisma.folder.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      harness.service.create(WORKSPACE, USER, { title: "x", folderId: FOLDER }),
    ).rejects.toMatchObject({ code: "project/folder_not_found" });
    expect(harness.prisma.project.create).not.toHaveBeenCalled();
  });
});

describe("ProjectsService.batchCreate", () => {
  it("creates every project in one transaction", async () => {
    const { service, prisma } = makeService();
    await service.batchCreate(WORKSPACE, USER, {
      projects: [{ title: "one" }, { title: "two" }],
      clientTag: "acme",
    });
    expect(prisma.withTransaction).toHaveBeenCalledTimes(1);
    expect(prisma.project.create).toHaveBeenCalledTimes(2);
    const second = callArg(prisma.project.create, 1, 0).data as Project;
    // The batch-level clientTag reaches a project that did not name its own.
    expect(second.clientTag).toBe("acme");
  });

  it("refuses a batch above the cap", async () => {
    const { service } = makeService();
    await expect(
      service.batchCreate(WORKSPACE, USER, {
        projects: Array.from({ length: PROJECT_BATCH_MAX + 1 }, () => ({ title: "x" })),
      }),
    ).rejects.toMatchObject({ code: "project/batch_too_large" });
  });
});

describe("ProjectsService.list", () => {
  it("always filters by the token's workspace and hides deleted rows", async () => {
    const { service, prisma } = makeService();
    await service.list(WORKSPACE, {
      q: "reel",
      status: "active",
      folder: FOLDER,
      clientTag: "acme",
    });
    const where = callArg(prisma.project.findMany, 0, 0).where as Record<string, unknown>;
    expect(where).toMatchObject({
      workspaceId: WORKSPACE,
      deletedAt: null,
      status: "active",
      folderId: FOLDER,
      clientTag: "acme",
    });
    expect(where["title"]).toEqual({ contains: "reel", mode: "insensitive" });
  });

  it("reads `folder=root` as 'in no folder'", async () => {
    const { service, prisma } = makeService();
    await service.list(WORKSPACE, { folder: "root" });
    const where = callArg(prisma.project.findMany, 0, 0).where as Record<string, unknown>;
    expect(where["folderId"]).toBeNull();
  });

  it("returns a cursor only when another page exists", async () => {
    const { service, prisma } = makeService();
    const rows = Array.from({ length: 3 }, (_unused, index) => ({
      ...projectRow({ id: `01JBZ0Q4T7R8N4H1V0J9K2M3P${String(index)}` }),
      _count: { mediaAssets: 0 },
    }));
    prisma.project.findMany.mockResolvedValueOnce(rows as never);
    const page = await service.list(WORKSPACE, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(page.items[1]?.id);

    prisma.project.findMany.mockResolvedValueOnce(rows.slice(0, 1) as never);
    expect((await service.list(WORKSPACE, { limit: 2 })).nextCursor).toBeNull();
  });

  it("clamps the page size", async () => {
    const { service, prisma } = makeService();
    await service.list(WORKSPACE, { limit: 10_000 });
    expect(callArg(prisma.project.findMany, 0, 0).take).toBe(101);
    await service.list(WORKSPACE, {});
    expect(callArg(prisma.project.findMany, 1, 0).take).toBe(26);
  });
});

describe("ProjectsService ownership (THREAT-MODEL T5)", () => {
  it("answers 404 for another tenant's project rather than 403", async () => {
    const { service, prisma } = makeService();
    prisma.project.findFirst.mockResolvedValueOnce(null as never);
    const error = await service.requireProject(OTHER_WORKSPACE, PROJECT).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "project/not_found", httpStatus: 404 });
    // The workspace is part of the query, not compared afterwards.
    expect(callArg(prisma.project.findFirst, 0, 0).where).toMatchObject({
      workspaceId: OTHER_WORKSPACE,
      deletedAt: null,
    });
  });
});

describe("ProjectsService.update and delete", () => {
  it("only writes the fields that were supplied, and touches activity", async () => {
    const { service, prisma } = makeService();
    await service.update(WORKSPACE, PROJECT, { title: "renamed", status: "archived" });
    const data = callArg(prisma.project.update, 0, 0).data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["lastActivityAt", "status", "title"]);
  });

  it("moves a project back to the root when folderId is null", async () => {
    const { service, prisma } = makeService();
    await service.update(WORKSPACE, PROJECT, { folderId: null });
    const data = callArg(prisma.project.update, 0, 0).data as Record<string, unknown>;
    expect(data["folderId"]).toBeNull();
    // No folder lookup: null is not an id to validate.
    expect(prisma.folder.findFirst).not.toHaveBeenCalled();
  });

  it("soft deletes rather than removing the row", async () => {
    const { service, prisma } = makeService();
    await expect(service.softDelete(WORKSPACE, PROJECT)).resolves.toEqual({ id: PROJECT });
    const data = callArg(prisma.project.update, 0, 0).data as Record<string, unknown>;
    expect(data["deletedAt"]).toBeInstanceOf(Date);
    expect(data["status"]).toBe("archived");
  });
});

describe("toProjectView", () => {
  it("renders times as ISO-8601 and the aspect in the contract's spelling", () => {
    const view = toProjectView(
      projectRow({ aspect: "r4x5", retentionUntil: new Date("2026-09-09T00:00:00.000Z") }),
      3,
    );
    expect(view.aspect).toBe("4:5");
    expect(view.retentionUntil).toBe("2026-09-09T00:00:00.000Z");
    expect(view.createdAt).toBe("2026-09-02T00:00:00.000Z");
    expect(view.mediaCount).toBe(3);
  });
});
