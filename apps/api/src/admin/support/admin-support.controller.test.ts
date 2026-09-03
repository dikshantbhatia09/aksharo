import { describe, expect, it, vi } from "vitest";

import { AdminSupportController } from "./admin-support.controller.js";

import type { AuthenticatedRequest, AuthPrincipal } from "../../common/guards/principal.js";

function harness() {
  const support = {
    list: vi.fn(),
    get: vi.fn(),
    setStatus: vi.fn(),
    reply: vi.fn(async () => undefined),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new AdminSupportController(support as never, audit as never);
  return { controller, support, audit };
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
    adminActiveRoles: ["support"],
    ip: "203.0.113.9",
    headers: {},
  } as unknown as AuthenticatedRequest;
}

describe("AdminSupportController.setStatus", () => {
  it("audits the before/after status", async () => {
    const h = harness();
    h.support.get.mockResolvedValue({ id: "t1", status: "open" });
    h.support.setStatus.mockResolvedValue({ id: "t1", status: "resolved" });

    await h.controller.setStatus("t1", { status: "resolved" } as never, request());

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.support.status_set",
        resourceId: "t1",
        data: { before: "open", after: "resolved" },
      }),
    );
  });
});

describe("AdminSupportController.reply", () => {
  it("404s before sending or auditing when the ticket does not exist", async () => {
    const h = harness();
    h.support.get.mockRejectedValue(new Error("not found"));

    await expect(
      h.controller.reply("missing", { body: "hi" } as never, request()),
    ).rejects.toThrow();

    expect(h.support.reply).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it("replies then audits the reply text", async () => {
    const h = harness();
    h.support.get.mockResolvedValue({ id: "t1", status: "open" });

    await h.controller.reply("t1", { body: "We restarted it." } as never, request());

    expect(h.support.reply).toHaveBeenCalledWith("t1", "We restarted it.");
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.support.replied",
        resourceId: "t1",
        data: { reply: "We restarted it." },
      }),
    );
  });
});
