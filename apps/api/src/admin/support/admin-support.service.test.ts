import { describe, expect, it, vi } from "vitest";

import { AdminSupportService } from "./admin-support.service.js";

function ticket(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "01JTICKET00000000000000000",
    workspaceId: "01JWORKSPACE00000000000000",
    userId: "01JUSER000000000000000000A",
    subject: "Export stuck",
    body: "It has been stuck at 90% for an hour.",
    category: "export",
    status: "open",
    diagnostics: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

function harness() {
  const prisma = {
    supportTicket: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: { findUnique: vi.fn() },
  };
  const notify = { enqueue: vi.fn(async () => ({ idempotencyKey: "k", enqueued: true })) };
  const service = new AdminSupportService(prisma as never, notify as never);
  return { service, prisma, notify };
}

describe("AdminSupportService.list", () => {
  it("filters by status and category when given", async () => {
    const h = harness();
    h.prisma.supportTicket.findMany.mockResolvedValue([ticket()]);

    await h.service.list({ status: "open", category: "export" });

    expect(h.prisma.supportTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "open", category: "export" } }),
    );
  });

  it("has no filter clauses when none are given", async () => {
    const h = harness();
    h.prisma.supportTicket.findMany.mockResolvedValue([]);

    await h.service.list({});

    expect(h.prisma.supportTicket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });
});

describe("AdminSupportService.get", () => {
  it("404s (as AppException) when the ticket does not exist", async () => {
    const h = harness();
    h.prisma.supportTicket.findUnique.mockResolvedValue(null);

    await expect(h.service.get("nope")).rejects.toThrow();
  });
});

describe("AdminSupportService.setStatus", () => {
  it("writes the status column directly (B13 owns this transition per the schema)", async () => {
    const h = harness();
    h.prisma.supportTicket.findUnique.mockResolvedValue(ticket());
    h.prisma.supportTicket.update.mockResolvedValue(ticket({ status: "resolved" }));

    const result = await h.service.setStatus("01JTICKET00000000000000000", "resolved");

    expect(h.prisma.supportTicket.update).toHaveBeenCalledWith({
      where: { id: "01JTICKET00000000000000000" },
      data: { status: "resolved" },
    });
    expect(result.status).toBe("resolved");
  });
});

describe("AdminSupportService.reply", () => {
  it("sends a support-ticket-reply notification to the ticket's own user", async () => {
    const h = harness();
    h.prisma.supportTicket.findUnique.mockResolvedValue(ticket());
    h.prisma.user.findUnique.mockResolvedValue({ email: "asha@example.test" });

    await h.service.reply("01JTICKET00000000000000000", "We restarted it.");

    expect(h.notify.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "support-ticket-reply",
        to: "asha@example.test",
        userId: "01JUSER000000000000000000A",
        workspaceId: "01JWORKSPACE00000000000000",
        data: expect.objectContaining({ replyBody: "We restarted it." }),
      }),
    );
  });

  it("is a no-op when the ticket's user has been deleted", async () => {
    const h = harness();
    h.prisma.supportTicket.findUnique.mockResolvedValue(ticket());
    h.prisma.user.findUnique.mockResolvedValue(null);

    await h.service.reply("01JTICKET00000000000000000", "hi");

    expect(h.notify.enqueue).not.toHaveBeenCalled();
  });
});
