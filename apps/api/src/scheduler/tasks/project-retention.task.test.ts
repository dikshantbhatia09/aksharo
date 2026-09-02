import { describe, expect, it, vi } from "vitest";

import { PROJECT_RETENTION_TASK, ProjectRetentionTask } from "./project-retention.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

const OWNER = { id: "u1", email: "owner@example.test", name: "Owner", locale: "en-IN" };

function harness(opts: {
  warnDue?: { id: string; title: string; retentionUntil: Date; workspaceId: string }[];
  purgeDue?: { id: string; workspaceId: string }[];
}) {
  const warnDue = opts.warnDue ?? [];
  const purgeDue = opts.purgeDue ?? [];
  const findMany = vi
    .fn()
    .mockResolvedValueOnce(warnDue.map((row) => ({ ...row, workspace: { owner: OWNER } })))
    .mockResolvedValueOnce(purgeDue);
  const enqueue = vi.fn(async () => ({ notificationId: null, jobId: "j1", enqueued: true }));
  const $transaction = vi.fn(async (ops: unknown[]) => ops);
  const record = vi.fn(async () => undefined);
  const prisma = {
    project: { findMany, update: vi.fn() },
    mediaAsset: { updateMany: vi.fn() },
    $transaction,
  };
  const notify = { enqueue };
  const audit = { record };
  const scheduler = { register: vi.fn() };
  const task = new ProjectRetentionTask(
    prisma as unknown as PrismaService,
    notify as unknown as import("../../notify/notify.service.js").NotifyService,
    audit as unknown as import("../../common/audit/audit.service.js").CommonAuditService,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, findMany, enqueue, $transaction, record, scheduler };
}

describe("registration", () => {
  it("registers a daily cron", () => {
    const { task, scheduler } = harness({});
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(PROJECT_RETENTION_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("sweep", () => {
  it("sends one retention-warning per project 14 days out, with an idempotency key", async () => {
    const retentionUntil = new Date("2026-09-24T00:00:00.000Z");
    const { task, enqueue } = harness({
      warnDue: [{ id: "p1", title: "Diwali reel", retentionUntil, workspaceId: "w1" }],
    });
    const report = await task.sweep(new Date("2026-09-10T00:00:00.000Z"));
    expect(report.warned).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "retention-warning",
        to: OWNER.email,
        idempotencyKey: `retention-warning-p1-${retentionUntil.toISOString()}`,
      }),
    );
  });

  it("soft-deletes a project past retentionUntil and pulls its media purge dates forward", async () => {
    const { task, $transaction, record } = harness({
      purgeDue: [{ id: "p2", workspaceId: "w2" }],
    });
    const report = await task.sweep();
    expect(report.purged).toBe(1);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "project.retention.purged", resourceId: "p2" }),
    );
  });

  it("does nothing when nothing is due", async () => {
    const { task, enqueue, $transaction } = harness({});
    const report = await task.sweep();
    expect(report).toEqual({ warned: 0, purged: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });
});
