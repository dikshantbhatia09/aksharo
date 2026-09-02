import { describe, expect, it, vi } from "vitest";

import { AdminCreditsController } from "./admin-credits.controller.js";

import type { AuthenticatedRequest, AuthPrincipal } from "../../common/guards/principal.js";

const WS = "01JWORKSPACE00000000000000";
const JOB = "01JJOB00000000000000000000";

function harness() {
  const orphanedHolds = { find: vi.fn(), resolveAll: vi.fn() };
  const reconcile = { reconcileAll: vi.fn(), reconcile: vi.fn() };
  const ledger = { grantLot: vi.fn(), reverse: vi.fn() };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new AdminCreditsController(
    orphanedHolds as never,
    reconcile as never,
    ledger as never,
    audit as never,
  );
  return { controller, orphanedHolds, reconcile, ledger, audit };
}

function request(): AuthenticatedRequest {
  const principal: AuthPrincipal = {
    userId: "01JADMIN00000000000000000A",
    workspaceId: WS,
    role: "owner",
    kind: "admin",
    jti: "j",
  };
  return {
    principal,
    adminActiveRoles: ["finance"],
    ip: "203.0.113.9",
    headers: {},
  } as unknown as AuthenticatedRequest;
}

describe("AdminCreditsController.adjust", () => {
  it("grants an adjust-sourced lot and writes an audit row carrying the reason", async () => {
    const h = harness();
    h.ledger.grantLot.mockResolvedValue({ lotId: "01JLOT0000000000000000000A" });

    const result = await h.controller.adjust(
      { workspaceId: WS, tenths: 500, reason: "goodwill for a support escalation" },
      request(),
    );

    expect(result).toEqual({ lotId: "01JLOT0000000000000000000A" });
    expect(h.ledger.grantLot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, source: "adjust", tenths: 500 }),
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.credits.adjusted",
        workspaceId: WS,
        data: expect.objectContaining({ tenths: 500 }),
      }),
    );
  });
});

describe("AdminCreditsController.reverse", () => {
  it("reverses a job's charge and writes an audit row", async () => {
    const h = harness();
    h.ledger.reverse.mockResolvedValue({ lotIds: ["01JLOT0000000000000000000B"] });

    const result = await h.controller.reverse(
      { workspaceId: WS, jobId: JOB, tenths: 120, reason: "bad artefact, job reversed by finance" },
      request(),
    );

    expect(result).toEqual({ lotIds: ["01JLOT0000000000000000000B"] });
    expect(h.ledger.reverse).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, jobId: JOB, tenths: 120 }),
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.credits.reversed", resourceId: JOB }),
    );
  });
});
