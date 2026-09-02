import { describe, expect, it, vi } from "vitest";

import { DEVICE_CODE_EXPIRY_TASK, DeviceCodeExpiryTask } from "./device-code-expiry.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

function harness(deviceCodes: number, pairings: number) {
  const prisma = {
    deviceCode: { deleteMany: vi.fn(async () => ({ count: deviceCodes })) },
    bridgePairing: { deleteMany: vi.fn(async () => ({ count: pairings })) },
  };
  const scheduler = { register: vi.fn() };
  const task = new DeviceCodeExpiryTask(
    prisma as unknown as PrismaService,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, prisma, scheduler };
}

describe("registration", () => {
  it("registers hourly, not a timer", () => {
    const { task, scheduler } = harness(0, 0);
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(DEVICE_CODE_EXPIRY_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("sweep", () => {
  it("deletes expired device codes and bridge pairings", async () => {
    const { task, prisma } = harness(3, 2);
    const now = new Date("2026-09-10T00:00:00.000Z");
    await expect(task.sweep(now)).resolves.toEqual({
      deviceCodesDeleted: 3,
      pairingsDeleted: 2,
    });
    expect(prisma.deviceCode.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now } },
    });
    expect(prisma.bridgePairing.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now } },
    });
  });

  it("is idempotent: a rerun with nothing left due deletes nothing", async () => {
    const { task } = harness(0, 0);
    await expect(task.sweep()).resolves.toEqual({ deviceCodesDeleted: 0, pairingsDeleted: 0 });
  });
});
