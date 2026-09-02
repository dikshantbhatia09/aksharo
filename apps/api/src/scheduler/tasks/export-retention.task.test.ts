import { describe, expect, it, vi } from "vitest";

import { EXPORT_RETENTION_TASK, ExportRetentionTask } from "./export-retention.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import type { ObjectStore } from "../../common/storage/index.js";

function harness(
  exportsDue: { id: string; storageKey: string | null }[],
  manifestsDeleted: number,
) {
  const findMany = vi.fn(async () => exportsDue);
  const update = vi.fn(async () => ({}));
  const deleteManyManifests = vi.fn(async () => ({ count: manifestsDeleted }));
  const del = vi.fn(async () => undefined);
  const prisma = {
    export: { findMany, update },
    exportManifest: { deleteMany: deleteManyManifests },
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
    expect(report).toEqual({ exportsExpired: 1, manifestsExpired: 2 });
  });

  it("is idempotent: a rerun with nothing left due deletes nothing", async () => {
    const { task, del } = harness([], 0);
    await task.sweep();
    expect(del).not.toHaveBeenCalled();
  });
});
