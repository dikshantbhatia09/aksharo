import { describe, expect, it, vi } from "vitest";

import { AdminReferralsController } from "./admin-referrals.controller.js";

import type { AuthenticatedRequest, AuthPrincipal } from "../../common/guards/principal.js";

function harness() {
  const prisma = { referralReward: { findMany: vi.fn() } };
  const referrals = { adminApproveHold: vi.fn(), adminRejectHold: vi.fn() };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new AdminReferralsController(
    prisma as never,
    referrals as never,
    audit as never,
  );
  return { controller, prisma, referrals, audit };
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
    adminActiveRoles: ["ops"],
    ip: "203.0.113.9",
    headers: {},
  } as unknown as AuthenticatedRequest;
}

describe("AdminReferralsController.reviewQueue", () => {
  it("lists only pending, held rows", async () => {
    const h = harness();
    h.prisma.referralReward.findMany.mockResolvedValue([
      {
        id: "01JR",
        referrerWorkspaceId: "01JWS1",
        referredWorkspaceId: "01JWS2",
        code: "AK-ABCDEF",
        holdReason: "chained_self_referral",
        createdAt: new Date(),
      },
    ]);
    const result = await h.controller.reviewQueue();
    expect(h.prisma.referralReward.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "pending", holdReason: { not: null } } }),
    );
    expect(result[0]?.holdReason).toBe("chained_self_referral");
  });
});

describe("AdminReferralsController.approve/reject", () => {
  it("approves and audits", async () => {
    const h = harness();
    await h.controller.approve("01JR", request());
    expect(h.referrals.adminApproveHold).toHaveBeenCalledWith("01JR");
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.referrals.hold_approved" }),
    );
  });

  it("rejects with the reason and audits", async () => {
    const h = harness();
    await h.controller.reject("01JR", { reason: "confirmed a duplicate signup" }, request());
    expect(h.referrals.adminRejectHold).toHaveBeenCalledWith(
      "01JR",
      "confirmed a duplicate signup",
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.referrals.hold_rejected" }),
    );
  });
});
