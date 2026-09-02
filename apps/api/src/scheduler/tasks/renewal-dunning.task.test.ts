import { describe, expect, it, vi } from "vitest";

import { RENEWAL_DUNNING_TASK, RenewalDunningTask } from "./renewal-dunning.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

function harness(due: { id: string }[], gracePaused: number) {
  const findMany = vi.fn(async () => due);
  const initiateRenewal = vi.fn(async () => undefined);
  const graceExpiry = vi.fn(async () => gracePaused);
  const prisma = { subscription: { findMany } };
  const renewal = { initiateRenewal, graceExpiry };
  const scheduler = { register: vi.fn() };
  const task = new RenewalDunningTask(
    prisma as unknown as PrismaService,
    renewal as unknown as import("../../billing/renewal.service.js").RenewalService,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, findMany, initiateRenewal, graceExpiry, scheduler };
}

describe("registration", () => {
  it("registers a daily cron", () => {
    const { task, scheduler } = harness([], 0);
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(RENEWAL_DUNNING_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("sweep", () => {
  it("calls initiateRenewal for every subscription past renewalInitiateAt, and graceExpiry always", async () => {
    const { task, initiateRenewal, graceExpiry } = harness([{ id: "s1" }, { id: "s2" }], 1);
    const report = await task.sweep();
    expect(initiateRenewal).toHaveBeenCalledTimes(2);
    expect(initiateRenewal).toHaveBeenCalledWith("s1");
    expect(initiateRenewal).toHaveBeenCalledWith("s2");
    expect(graceExpiry).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ renewalsInitiated: 2, gracePaused: 1 });
  });

  it("only queries active/past_due/trialing subscriptions still within their period", async () => {
    const { task, findMany } = harness([], 0);
    const now = new Date("2026-09-10T00:00:00.000Z");
    await task.sweep(now);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          renewalInitiateAt: { lte: now },
          status: { in: ["active", "past_due", "trialing"] },
          currentPeriodEnd: { gt: now },
        }) as unknown,
      }),
    );
  });

  it("does nothing extra when nothing is due — safe to run twice", async () => {
    const { task, initiateRenewal } = harness([], 0);
    await task.sweep();
    await task.sweep();
    expect(initiateRenewal).not.toHaveBeenCalled();
  });
});
