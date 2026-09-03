import { describe, expect, it, vi } from "vitest";

import { OpsIncidentsService, toStatusIncident } from "./ops-incidents.service.js";

import type { CommonAuditService } from "../common/audit/audit.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";

function harness() {
  const created = { id: "existing-row" };
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    ...args.data,
  }));
  const findUnique = vi.fn(async (): Promise<typeof created | null> => created);
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    ...created,
    ...args.data,
  }));
  const findMany = vi.fn(async () => []);
  const record = vi.fn(async () => undefined);
  const prisma = {
    opsIncident: { create, findUnique, update, findMany },
  } as unknown as PrismaService;
  const audit = { record } as unknown as CommonAuditService;
  const service = new OpsIncidentsService(prisma, audit);
  return { service, create, findUnique, update, findMany, record };
}

describe("create", () => {
  it("defaults severity to minor and status to investigating, and audits", async () => {
    const { service, create, record } = harness();
    await service.create(
      { title: "Render lane slow", body: "Investigating.", component: "render" },
      "admin-1",
      "1.2.3.4",
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ severity: "minor", status: "investigating" }),
      }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.ops_incident.created", actorId: "admin-1" }),
    );
  });
});

describe("update", () => {
  it("returns null for an unknown id", async () => {
    const { service, findUnique } = harness();
    findUnique.mockResolvedValueOnce(null);
    const result = await service.update("missing", { status: "resolved" }, "admin-1");
    expect(result).toBeNull();
  });

  it("updates only the fields given and audits the change", async () => {
    const { service, update, record } = harness();
    const result = await service.update("existing-row", { status: "resolved" }, "admin-1");
    expect(result).not.toBeNull();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "resolved" } }));
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.ops_incident.updated" }),
    );
  });
});

describe("toStatusIncident", () => {
  it("serialises dates to ISO strings and passes resolvedAt through as null", () => {
    const row = {
      id: "01ABC",
      title: "t",
      body: "b",
      component: "queue",
      severity: "minor" as const,
      status: "monitoring" as const,
      startedAt: new Date("2026-09-10T00:00:00.000Z"),
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const view = toStatusIncident(row);
    expect(view.startedAt).toBe("2026-09-10T00:00:00.000Z");
    expect(view.resolvedAt).toBeNull();
  });
});
