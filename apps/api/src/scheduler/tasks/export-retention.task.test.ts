import { describe, expect, it, vi } from "vitest";

import {
  EXPORT_RETENTION_TASK,
  ExportRetentionTask,
  SHARED_VIDEO_GRACE_MS,
} from "./export-retention.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import type { ObjectStore } from "../../common/storage/index.js";

interface Shared {
  readonly variants?: unknown[];
  readonly dubVariants?: unknown[];
  readonly guestLinks?: unknown[];
  readonly reviewLinks?: unknown[];
}

function harness(
  exportsDue: { id: string; storageKey: string | null }[],
  manifestsDeleted: number,
  shared: Shared = {},
) {
  const findMany = vi.fn(async () => exportsDue);
  const update = vi.fn(async () => ({}));
  const deleteManyManifests = vi.fn(async () => ({ count: manifestsDeleted }));
  const del = vi.fn(async () => undefined);
  const prisma = {
    export: { findMany, update },
    exportManifest: { deleteMany: deleteManyManifests },
    clipVariant: { findMany: vi.fn(async () => shared.variants ?? []) },
    clipDubVariant: { findMany: vi.fn(async () => shared.dubVariants ?? []) },
    clipGuestLink: { findMany: vi.fn(async () => shared.guestLinks ?? []) },
    clipReviewLink: { findMany: vi.fn(async () => shared.reviewLinks ?? []) },
  };
  const derived = { delete: del } as unknown as ObjectStore;
  const scheduler = { register: vi.fn() };
  const task = new ExportRetentionTask(
    prisma as unknown as PrismaService,
    derived,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, findMany, update, deleteManyManifests, del, scheduler };
}

describe("registration", () => {
  it("registers an hourly cron", () => {
    const { task, scheduler } = harness([], 0);
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(EXPORT_RETENTION_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("sweep", () => {
  it("deletes the export object then nulls storageKey, and deletes expired manifests outright", async () => {
    const { task, del, update, deleteManyManifests } = harness(
      [{ id: "e1", storageKey: "ws/w/p/p1/exports/e1.mp4" }],
      2,
    );
    const report = await task.sweep();
    expect(del).toHaveBeenCalledWith("ws/w/p/p1/exports/e1.mp4");
    expect(update).toHaveBeenCalledWith({ where: { id: "e1" }, data: { storageKey: null } });
    expect(deleteManyManifests).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ exportsExpired: 1, exportsKeptShared: 0, manifestsExpired: 2 });
  });

  it("is idempotent: a rerun with nothing left due deletes nothing", async () => {
    const { task, del } = harness([], 0);
    await task.sweep();
    expect(del).not.toHaveBeenCalled();
  });
});

describe("exempt workspaces (owner decision 2026-09-29)", () => {
  it("never selects a render from an exempt workspace", async () => {
    vi.stubEnv("RETENTION_EXEMPT_WORKSPACE_IDS", "01M1KFX35NJRD5N58H0J6YGAPC");
    try {
      const { task, findMany } = harness([], 0);
      await task.sweep();
      const where = (findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0]
        .where;
      expect(where["workspaceId"]).toEqual({ notIn: ["01M1KFX35NJRD5N58H0J6YGAPC"] });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("videos shared through a live link are kept (2026-09-30)", () => {
  const NOW = new Date("2026-10-10T00:00:00Z");
  const LINK_END = new Date("2026-10-20T00:00:00Z");
  const KEPT_UNTIL = new Date(LINK_END.getTime() + SHARED_VIDEO_GRACE_MS);
  const due = [{ id: "e1", storageKey: "ws/w/p/p1/exports/e1.mp4" }];
  const variant = (aspect: string) => ({
    latestExportId: "e1",
    aspect,
    clip: { id: "c1", runId: "r1" },
  });

  it("moves a shared clip video's expiry to a day after its guest link ends, and deletes nothing", async () => {
    const { task, del, update } = harness(due, 0, {
      variants: [variant("r4x5")],
      guestLinks: [
        { runId: "r1", allClips: false, clipIds: ["c1"], includeDubs: false, expiresAt: LINK_END },
      ],
    });
    const report = await task.sweep(NOW);
    expect(del).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ where: { id: "e1" }, data: { expiresAt: KEPT_UNTIL } });
    expect(report).toMatchObject({ exportsExpired: 0, exportsKeptShared: 1 });
  });

  it("keeps a clip that an all-clips guest link covers", async () => {
    const { task, del } = harness(due, 0, {
      variants: [variant("r16x9")],
      guestLinks: [
        { runId: "r1", allClips: true, clipIds: [], includeDubs: false, expiresAt: LINK_END },
      ],
    });
    await task.sweep(NOW);
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes a clip the guest link does not share", async () => {
    const { task, del } = harness(due, 0, {
      variants: [variant("r9x16")],
      guestLinks: [
        {
          runId: "r1",
          allClips: false,
          clipIds: ["other"],
          includeDubs: false,
          expiresAt: LINK_END,
        },
      ],
    });
    await task.sweep(NOW);
    expect(del).toHaveBeenCalledWith("ws/w/p/p1/exports/e1.mp4");
  });

  it("keeps only the 9:16 for a client review link, which shows nothing else", async () => {
    const portrait = harness(due, 0, {
      variants: [variant("r9x16")],
      reviewLinks: [{ runId: "r1", expiresAt: LINK_END }],
    });
    await portrait.task.sweep(NOW);
    expect(portrait.del).not.toHaveBeenCalled();

    const square = harness(due, 0, {
      variants: [variant("r1x1")],
      reviewLinks: [{ runId: "r1", expiresAt: LINK_END }],
    });
    await square.task.sweep(NOW);
    expect(square.del).toHaveBeenCalled();
  });

  it("keeps a dubbed video only when the guest link includes dubs", async () => {
    const dubbed = { latestExportId: "e1", dub: { clipId: "c1", runId: "r1" } };
    const withDubs = harness(due, 0, {
      dubVariants: [dubbed],
      guestLinks: [
        { runId: "r1", allClips: true, clipIds: [], includeDubs: true, expiresAt: LINK_END },
      ],
    });
    await withDubs.task.sweep(NOW);
    expect(withDubs.del).not.toHaveBeenCalled();

    const withoutDubs = harness(due, 0, {
      dubVariants: [dubbed],
      guestLinks: [
        { runId: "r1", allClips: true, clipIds: [], includeDubs: false, expiresAt: LINK_END },
      ],
    });
    await withoutDubs.task.sweep(NOW);
    expect(withoutDubs.del).toHaveBeenCalled();
  });

  it("asks only for live links: not revoked, not yet ended", async () => {
    const { task } = harness(due, 0, { variants: [variant("r9x16")] });
    const guest = (
      task as unknown as { prisma: { clipGuestLink: { findMany: ReturnType<typeof vi.fn> } } }
    ).prisma.clipGuestLink.findMany;
    await task.sweep(NOW);
    const where = (guest.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where["revokedAt"]).toBeNull();
    expect(where["expiresAt"]).toEqual({ gt: NOW });
  });
});
