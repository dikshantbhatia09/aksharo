import { describe, expect, it, vi } from "vitest";

import {
  PROVIDER_DELETION_FOLLOWUP_TASK,
  ProviderDeletionFollowupTask,
} from "./provider-deletion-followup.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

function harness(
  due: {
    id: string;
    provider: string;
    externalRef: string | null;
    endpoint: string | null;
    workspaceId: string;
  }[],
) {
  const findMany = vi.fn(async () => due);
  const record = vi.fn(async () => undefined);
  const prisma = { providerSubmission: { findMany, update: vi.fn() } };
  const audit = { record };
  const scheduler = { register: vi.fn() };
  const task = new ProviderDeletionFollowupTask(
    prisma as unknown as PrismaService,
    audit as unknown as import("../../common/audit/audit.service.js").CommonAuditService,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, findMany, record, scheduler };
}

describe("registration", () => {
  it("registers a daily cron", () => {
    const { task, scheduler } = harness([]);
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(PROVIDER_DELETION_FOLLOWUP_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("sweep", () => {
  it("logs a manual task for every provider with no registered deletion API", async () => {
    const { task, record } = harness([
      { id: "ps1", provider: "sarvam", externalRef: "abc", endpoint: null, workspaceId: "w1" },
      { id: "ps2", provider: "elevenlabs", externalRef: "def", endpoint: null, workspaceId: "w1" },
    ]);
    const report = await task.sweep();
    expect(report).toEqual({ autoConfirmed: 0, manualTasksLogged: 2 });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "privacy.provider_deletion.manual_task" }),
    );
  });

  it("does nothing, and does not page, when nothing is due", async () => {
    const { task, record } = harness([]);
    const report = await task.sweep();
    expect(report).toEqual({ autoConfirmed: 0, manualTasksLogged: 0 });
    expect(record).not.toHaveBeenCalled();
  });
});
