import { describe, expect, it, vi } from "vitest";

import { AdminUsersService } from "./admin-users.service.js";
import { AppException } from "../../common/errors/error-codes.js";

const USER = "01JUSER000000000000000000A";
const WS = "01JWORKSPACE00000000000000";

function harness() {
  const prisma = {
    user: { findMany: vi.fn(), findUnique: vi.fn() },
    membership: { findMany: vi.fn(), count: vi.fn() },
    device: { count: vi.fn() },
    adminRole: { findMany: vi.fn() },
    workspace: { findMany: vi.fn(), findUnique: vi.fn() },
    creditAccount: { findUnique: vi.fn() },
    subscription: { findFirst: vi.fn() },
  };
  const service = new AdminUsersService(prisma as never);
  return { service, prisma };
}

describe("AdminUsersService.searchUsers", () => {
  it("pages by id and reports nextCursor only when the page is full", async () => {
    const h = harness();
    h.prisma.user.findMany.mockResolvedValue([
      {
        id: "a",
        email: "a@x.com",
        name: null,
        isAdmin: false,
        createdAt: new Date(),
        lastSeenAt: null,
        deletedAt: null,
      },
    ]);

    const full = await h.service.searchUsers({ limit: 1 } as never);
    expect(full.nextCursor).toBe("a");

    h.prisma.user.findMany.mockResolvedValue([]);
    const empty = await h.service.searchUsers({ limit: 25 } as never);
    expect(empty.nextCursor).toBeUndefined();
  });
});

describe("AdminUsersService.userDetail", () => {
  it("404s a user that does not exist", async () => {
    const h = harness();
    h.prisma.user.findUnique.mockResolvedValue(null);
    await expect(h.service.userDetail(USER)).rejects.toBeInstanceOf(AppException);
  });

  it("assembles memberships, device count and active admin roles", async () => {
    const h = harness();
    h.prisma.user.findUnique.mockResolvedValue({
      id: USER,
      email: "u@x.com",
      name: "U",
      isAdmin: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenAt: null,
      deletedAt: null,
    });
    h.prisma.membership.findMany.mockResolvedValue([
      { workspaceId: WS, role: "owner", status: "active", workspace: { id: WS, name: "Acme" } },
    ]);
    h.prisma.device.count.mockResolvedValue(2);
    h.prisma.adminRole.findMany.mockResolvedValue([{ role: "finance" }]);

    const detail = await h.service.userDetail(USER);

    expect(detail.deviceCount).toBe(2);
    expect(detail.adminRoles).toEqual(["finance"]);
    expect(detail.memberships).toEqual([
      { workspaceId: WS, workspaceName: "Acme", role: "owner", status: "active" },
    ]);
  });
});

describe("AdminUsersService.workspaceDetail", () => {
  it("404s a workspace that does not exist", async () => {
    const h = harness();
    h.prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(h.service.workspaceDetail(WS)).rejects.toBeInstanceOf(AppException);
  });

  it("assembles owner, member count, credit account and subscription", async () => {
    const h = harness();
    h.prisma.workspace.findUnique.mockResolvedValue({
      id: WS,
      slug: "acme",
      name: "Acme",
      type: "team",
      ownerId: USER,
      currency: "INR",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      deletedAt: null,
    });
    h.prisma.user.findUnique.mockResolvedValue({ email: "owner@x.com" });
    h.prisma.membership.count.mockResolvedValue(3);
    h.prisma.creditAccount.findUnique.mockResolvedValue({
      balanceTenths: 1000,
      monthlyGrantTenths: 500,
      grantResetAt: null,
      negativeAllowed: false,
    });
    h.prisma.subscription.findFirst.mockResolvedValue({
      planId: "pro",
      status: "active",
      currency: "INR",
      currentPeriodEnd: new Date("2026-03-01T00:00:00Z"),
      cancelAtPeriodEnd: false,
    });

    const detail = await h.service.workspaceDetail(WS);

    expect(detail.ownerEmail).toBe("owner@x.com");
    expect(detail.memberCount).toBe(3);
    expect(detail.creditAccount?.balanceTenths).toBe(1000);
    expect(detail.subscription?.planId).toBe("pro");
  });
});
