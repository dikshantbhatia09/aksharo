import { describe, expect, it, vi } from "vitest";

import { AdminFlagsController } from "./admin-flags.controller.js";
import { AppException } from "../../common/errors/error-codes.js";

import type { AuthenticatedRequest, AuthPrincipal } from "../../common/guards/principal.js";

function harness() {
  const prisma = {
    featureFlag: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new AdminFlagsController(prisma as never, audit as never);
  return { controller, prisma, audit };
}

function request(): AuthenticatedRequest {
  const principal: AuthPrincipal = {
    userId: "01JADMIN00000000000000000A",
    workspaceId: "01JWORKSPACE00000000000000",
    role: "owner",
    kind: "admin",
    jti: "j",
  };
  return {
    principal,
    adminActiveRoles: ["superadmin"],
    ip: "203.0.113.9",
    headers: {},
  } as unknown as AuthenticatedRequest;
}

describe("AdminFlagsController.create", () => {
  it("409s a duplicate key without writing anything", async () => {
    const h = harness();
    h.prisma.featureFlag.findUnique.mockResolvedValue({ id: "existing" });
    await expect(
      h.controller.create(
        {
          key: "new_editor",
          enabled: false,
          rolloutPct: 0,
          targets: { workspaceIds: [], planKeys: [], excludeWorkspaceIds: [] },
        },
        request(),
      ),
    ).rejects.toBeInstanceOf(AppException);
    expect(h.prisma.featureFlag.create).not.toHaveBeenCalled();
  });

  it("creates a flag and audits it", async () => {
    const h = harness();
    h.prisma.featureFlag.findUnique.mockResolvedValue(null);
    h.prisma.featureFlag.create.mockResolvedValue({
      id: "01JFLAG0000000000000000000",
      key: "new_editor",
      description: null,
      enabled: false,
      rolloutPct: 0,
      targets: { workspaceIds: [], planKeys: [], excludeWorkspaceIds: [] },
      updatedAt: new Date(),
    });

    const result = await h.controller.create(
      {
        key: "new_editor",
        enabled: false,
        rolloutPct: 0,
        targets: { workspaceIds: [], planKeys: [], excludeWorkspaceIds: [] },
      },
      request(),
    );

    expect(result.key).toBe("new_editor");
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.flags.created" }),
    );
  });
});

describe("AdminFlagsController.update", () => {
  it("404s an unknown flag", async () => {
    const h = harness();
    h.prisma.featureFlag.findUnique.mockResolvedValue(null);
    await expect(
      h.controller.update("nope", { reason: "raising rollout for the beta cohort" }, request()),
    ).rejects.toBeInstanceOf(AppException);
  });

  it("updates and audits a before/after diff with the reason", async () => {
    const h = harness();
    h.prisma.featureFlag.findUnique.mockResolvedValue({
      id: "01JFLAG0000000000000000000",
      key: "new_editor",
      enabled: false,
      rolloutPct: 0,
      targets: {},
    });
    h.prisma.featureFlag.update.mockResolvedValue({
      id: "01JFLAG0000000000000000000",
      key: "new_editor",
      description: null,
      enabled: true,
      rolloutPct: 25,
      targets: { workspaceIds: [], planKeys: [], excludeWorkspaceIds: [] },
      updatedAt: new Date(),
    });

    const result = await h.controller.update(
      "new_editor",
      { enabled: true, rolloutPct: 25, reason: "raising rollout for the beta cohort" },
      request(),
    );

    expect(result.enabled).toBe(true);
    expect(result.rolloutPct).toBe(25);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.flags.updated",
        data: expect.objectContaining({ reason: "raising rollout for the beta cohort" }),
      }),
    );
  });
});

describe("AdminFlagsController.remove", () => {
  it("404s an unknown flag", async () => {
    const h = harness();
    h.prisma.featureFlag.findUnique.mockResolvedValue(null);
    await expect(h.controller.remove("nope", request())).rejects.toBeInstanceOf(AppException);
    expect(h.prisma.featureFlag.delete).not.toHaveBeenCalled();
  });

  it("deletes and audits", async () => {
    const h = harness();
    h.prisma.featureFlag.findUnique.mockResolvedValue({
      id: "01JFLAG0000000000000000000",
      key: "old",
    });
    await h.controller.remove("old", request());
    expect(h.prisma.featureFlag.delete).toHaveBeenCalledWith({ where: { key: "old" } });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.flags.deleted" }),
    );
  });
});
