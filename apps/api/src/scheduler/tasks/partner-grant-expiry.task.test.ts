import { describe, expect, it, vi } from "vitest";

import { PARTNER_GRANT_EXPIRY_TASK, PartnerGrantExpiryTask } from "./partner-grant-expiry.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

function harness(due: Array<{ id: string }>) {
  const prisma = {
    assetClearanceGrant: {
      findMany: vi.fn(async () => due),
      updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => ({
        count: where.id.in.length,
      })),
    },
  };
  const scheduler = { register: vi.fn() };
  const task = new PartnerGrantExpiryTask(
    prisma as unknown as PrismaService,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, prisma, scheduler };
}

describe("registration", () => {
  it("registers hourly, not a timer", () => {
    const { task, scheduler } = harness([]);
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(PARTNER_GRANT_EXPIRY_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("sweep — fake clock", () => {
  it("marks grants past expiresAt as expired, using the passed-in instant", async () => {
    const { task, prisma } = harness([{ id: "g1" }, { id: "g2" }]);
    const at = new Date("2026-09-10T00:00:00.000Z");
    await expect(task.sweep(at)).resolves.toEqual({ expired: 2 });
    expect(prisma.assetClearanceGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "active", expiresAt: { not: null, lte: at } },
      }),
    );
    expect(prisma.assetClearanceGrant.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["g1", "g2"] } },
      data: { status: "expired" },
    });
  });

  it("is idempotent: nothing due sweeps to zero without a write", async () => {
    const { task, prisma } = harness([]);
    await expect(task.sweep(new Date("2026-09-10T00:00:00.000Z"))).resolves.toEqual({
      expired: 0,
    });
    expect(prisma.assetClearanceGrant.updateMany).not.toHaveBeenCalled();
  });

  it("defaults to the real clock when no instant is passed", async () => {
    const { task } = harness([]);
    await expect(task.sweep()).resolves.toEqual({ expired: 0 });
  });
});
