import { describe, expect, it, vi } from "vitest";

import { ReferralsService } from "./referrals.service.js";
import { AppException } from "../common/errors/error-codes.js";

const REFERRAL_ID = "01JREFERRAL000000000000000";
const REFERRER_WS = "01JREFERRERWS0000000000000";
const REFERRED_WS = "01JREFERREDWS0000000000000";

function harness() {
  const prisma = {
    referralReward: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    workspace: { updateMany: vi.fn() },
  };
  const entitlements = { forWorkspace: vi.fn(async () => ({ planKey: "creator" })) };
  const credits = {
    grantLot: vi.fn(async () => ({ lotId: "01JLOT0000000000000000000A" })),
  };
  const service = new ReferralsService(prisma as never, entitlements as never, credits as never);
  return { service, prisma, entitlements, credits };
}

describe("ReferralsService.adminApproveHold — B13 orchestrator addendum", () => {
  it("404s when there is no pending row with that id", async () => {
    const h = harness();
    h.prisma.referralReward.findFirst.mockResolvedValue(null);
    await expect(h.service.adminApproveHold(REFERRAL_ID)).rejects.toBeInstanceOf(AppException);
  });

  it("settles through the normal cap-check/grant path (paid referrer: granted)", async () => {
    const h = harness();
    h.prisma.referralReward.findFirst.mockResolvedValue({
      id: REFERRAL_ID,
      referrerWorkspaceId: REFERRER_WS,
      referredWorkspaceId: REFERRED_WS,
      code: "AK-ABCDEF",
      holdReason: "chained_self_referral",
    });
    h.prisma.referralReward.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.referralReward.count.mockResolvedValue(0);

    await h.service.adminApproveHold(REFERRAL_ID);

    expect(h.prisma.referralReward.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: REFERRAL_ID, status: "pending" },
        data: expect.objectContaining({ status: "granted" }),
      }),
    );
    expect(h.credits.grantLot).toHaveBeenCalledTimes(2);
  });

  it("still respects the Free-plan monthly cap when approved", async () => {
    const h = harness();
    h.entitlements.forWorkspace.mockResolvedValue({ planKey: "free" });
    h.prisma.referralReward.findFirst.mockResolvedValue({
      id: REFERRAL_ID,
      referrerWorkspaceId: REFERRER_WS,
      referredWorkspaceId: REFERRED_WS,
      code: "AK-ABCDEF",
      holdReason: "chained_self_referral",
    });
    h.prisma.referralReward.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.referralReward.count.mockResolvedValue(10); // at the cap

    await h.service.adminApproveHold(REFERRAL_ID);

    expect(h.prisma.referralReward.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "rejected" }) }),
    );
    expect(h.credits.grantLot).not.toHaveBeenCalled();
  });
});

describe("ReferralsService.adminRejectHold", () => {
  it("404s when there is no pending row with that id", async () => {
    const h = harness();
    h.prisma.referralReward.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      h.service.adminRejectHold(REFERRAL_ID, "confirmed a duplicate signup"),
    ).rejects.toBeInstanceOf(AppException);
  });

  it("rejects with the given reason", async () => {
    const h = harness();
    h.prisma.referralReward.updateMany.mockResolvedValue({ count: 1 });
    await h.service.adminRejectHold(REFERRAL_ID, "confirmed a duplicate signup");
    expect(h.prisma.referralReward.updateMany).toHaveBeenCalledWith({
      where: { id: REFERRAL_ID, status: "pending" },
      data: { status: "rejected", reason: "confirmed a duplicate signup" },
    });
  });
});
