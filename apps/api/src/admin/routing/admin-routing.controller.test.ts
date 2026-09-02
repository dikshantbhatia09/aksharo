import { describe, expect, it, vi } from "vitest";

import { AdminRoutingController } from "./admin-routing.controller.js";

import type { AuthenticatedRequest, AuthPrincipal } from "../../common/guards/principal.js";

function harness() {
  const prisma = {
    routingWeightOverride: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
  };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new AdminRoutingController(prisma as never, audit as never);
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

describe("AdminRoutingController.set", () => {
  it("upserts an override and audits before/after weights", async () => {
    const h = harness();
    h.prisma.routingWeightOverride.findUnique.mockResolvedValue({ weight: 0 });
    h.prisma.routingWeightOverride.upsert.mockResolvedValue({
      id: "01JRWO0000000000000000000A",
      laneId: "hinglish",
      provider: "elevenlabs",
      weight: 50,
      updatedBy: "01JADMIN00000000000000000A",
      updatedAt: new Date(),
    });

    const result = await h.controller.set(
      {
        laneId: "hinglish",
        provider: "elevenlabs",
        weight: 50,
        reason: "shadow-routing rollout, phase 1",
      },
      request(),
    );

    expect(result.weight).toBe(50);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.routing.weight_set",
        data: expect.objectContaining({ beforeWeight: 0, afterWeight: 50 }),
      }),
    );
  });
});

describe("AdminRoutingController.clear", () => {
  it("is a no-op when no override is on file", async () => {
    const h = harness();
    h.prisma.routingWeightOverride.findUnique.mockResolvedValue(null);
    await h.controller.clear("hinglish", "elevenlabs", request());
    expect(h.prisma.routingWeightOverride.delete).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it("deletes and audits when one exists", async () => {
    const h = harness();
    h.prisma.routingWeightOverride.findUnique.mockResolvedValue({
      id: "01JRWO0000000000000000000A",
      weight: 50,
    });
    await h.controller.clear("hinglish", "elevenlabs", request());
    expect(h.prisma.routingWeightOverride.delete).toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.routing.weight_cleared" }),
    );
  });
});
