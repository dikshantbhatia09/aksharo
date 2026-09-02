import { describe, expect, it, vi } from "vitest";

import { AdminStylesController } from "./admin-styles.controller.js";
import { AppException } from "../../common/errors/error-codes.js";

import type { AuthenticatedRequest, AuthPrincipal } from "../../common/guards/principal.js";

function harness() {
  const prisma = {
    stylePreset: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new AdminStylesController(prisma as never, audit as never);
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
    adminActiveRoles: ["content"],
    ip: "203.0.113.9",
    headers: {},
  } as unknown as AuthenticatedRequest;
}

function styleRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "01JSTYLE000000000000000000",
    workspaceId: null,
    key: "punch-pop",
    name: "Punch Pop",
    category: "general",
    published: true,
    minPlan: "free",
    version: 1,
    assRenderable: true,
    assExportable: true,
    requiresLayoutMetrics: false,
    parityScore: 0.98,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("AdminStylesController.list", () => {
  it("only returns the system catalogue, with parity fields folded in", async () => {
    const h = harness();
    h.prisma.stylePreset.findMany.mockResolvedValue([styleRow()]);

    const result = await h.controller.list();

    expect(h.prisma.stylePreset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: null } }),
    );
    expect(result[0]?.parity).toEqual({
      assRenderable: true,
      assExportable: true,
      requiresLayoutMetrics: false,
      parityScore: 0.98,
    });
  });
});

describe("AdminStylesController.publish", () => {
  it("404s a style that is not in the system catalogue", async () => {
    const h = harness();
    h.prisma.stylePreset.findFirst.mockResolvedValue(null);
    await expect(
      h.controller.publish(
        "nope",
        { published: false, reason: "pulled for a rendering bug" },
        request(),
      ),
    ).rejects.toBeInstanceOf(AppException);
    expect(h.prisma.stylePreset.update).not.toHaveBeenCalled();
  });

  it("unpublishes and audits with the reason", async () => {
    const h = harness();
    h.prisma.stylePreset.findFirst.mockResolvedValue(styleRow());
    h.prisma.stylePreset.update.mockResolvedValue(styleRow({ published: false }));

    const result = await h.controller.publish(
      "01JSTYLE000000000000000000",
      { published: false, reason: "pulled for a rendering bug" },
      request(),
    );

    expect(result.published).toBe(false);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.styles.unpublished",
        data: expect.objectContaining({ reason: "pulled for a rendering bug" }),
      }),
    );
  });
});
