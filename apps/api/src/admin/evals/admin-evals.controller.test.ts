import { describe, expect, it, vi } from "vitest";

import { AdminEvalsController, buildLeaderboard } from "./admin-evals.controller.js";

import type { AuthenticatedRequest, AuthPrincipal } from "../../common/guards/principal.js";
import type { EvalResult } from "@prisma/client";

function harness() {
  const prisma = {
    evalResult: { findMany: vi.fn() },
    routingFreeze: { findUnique: vi.fn(), upsert: vi.fn() },
  };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new AdminEvalsController(prisma as never, audit as never);
  return { controller, prisma, audit };
}

function request(roles: string[] = ["superadmin"]): AuthenticatedRequest {
  const principal: AuthPrincipal = {
    userId: "01JADMIN00000000000000000A",
    workspaceId: "01JWORKSPACE00000000000000",
    role: "owner",
    kind: "admin",
    jti: "j",
  };
  return {
    principal,
    adminActiveRoles: roles,
    ip: "203.0.113.9",
    headers: {},
  } as unknown as AuthenticatedRequest;
}

function row(overrides: Partial<EvalResult>): EvalResult {
  return {
    id: "01JRES0000000000000000000A",
    runId: "01JRUN0000000000000000000A",
    dataset: "hindi-synth",
    kind: "transcript",
    language: "hi",
    provider: null,
    metricName: "corpusWer",
    metricValue: 0.1,
    itemCount: 3,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  } as EvalResult;
}

describe("buildLeaderboard", () => {
  it("takes the latest row per (dataset, language, provider, metric)", () => {
    const rows = [
      row({ id: "a", metricValue: 0.2, createdAt: new Date("2026-09-02T00:00:00Z") }),
      row({ id: "b", metricValue: 0.3, createdAt: new Date("2026-09-01T00:00:00Z") }),
    ];
    const out = buildLeaderboard(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.metricValue).toBe(0.2);
    expect(out[0]?.previousMetricValue).toBe(0.3);
    expect(out[0]?.trend).toBeCloseTo(-0.1);
  });

  it("keeps separate groups per dataset/language/provider/metric", () => {
    const rows = [
      row({ id: "a", dataset: "hindi-synth" }),
      row({ id: "b", dataset: "tamil-synth" }),
      row({ id: "c", metricName: "corpusCer" }),
      row({ id: "d", provider: "sarvam" }),
    ];
    const out = buildLeaderboard(rows);
    expect(out).toHaveLength(4);
  });

  it("has no previous/trend when there is only one run", () => {
    const out = buildLeaderboard([row({ id: "a" })]);
    expect(out[0]?.previousMetricValue).toBeUndefined();
    expect(out[0]?.trend).toBeUndefined();
  });

  it("returns nothing for an empty window", () => {
    expect(buildLeaderboard([])).toEqual([]);
  });
});

describe("AdminEvalsController.leaderboard", () => {
  it("reads a bounded recent window and groups it", async () => {
    const h = harness();
    h.prisma.evalResult.findMany.mockResolvedValue([row({})]);
    const out = await h.controller.leaderboard();
    expect(out).toHaveLength(1);
    expect(h.prisma.evalResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } }),
    );
  });
});

describe("AdminEvalsController freeze/unfreeze", () => {
  it("freezes with a reason and audits the transition", async () => {
    const h = harness();
    h.prisma.routingFreeze.findUnique.mockResolvedValue({ frozen: false });
    h.prisma.routingFreeze.upsert.mockResolvedValue({
      id: "singleton",
      frozen: true,
      reason: "shadow candidate regressed WER",
      updatedBy: "01JADMIN00000000000000000A",
      updatedAt: new Date("2026-09-03T00:00:00Z"),
    });

    const result = await h.controller.freeze(
      { reason: "shadow candidate regressed WER" },
      request(),
    );

    expect(result.frozen).toBe(true);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.evals.routing_frozen",
        data: expect.objectContaining({ isFrozen: true, wasFrozen: false }),
      }),
    );
  });

  it("unfreezes with a reason and audits the transition", async () => {
    const h = harness();
    h.prisma.routingFreeze.findUnique.mockResolvedValue({ frozen: true });
    h.prisma.routingFreeze.upsert.mockResolvedValue({
      id: "singleton",
      frozen: false,
      reason: "false alarm, unfreezing",
      updatedBy: "01JADMIN00000000000000000A",
      updatedAt: new Date("2026-09-03T01:00:00Z"),
    });

    const result = await h.controller.unfreeze({ reason: "false alarm, unfreezing" }, request());

    expect(result.frozen).toBe(false);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.evals.routing_unfrozen" }),
    );
  });

  it("getFreeze reports unfrozen when no row exists yet", async () => {
    const h = harness();
    h.prisma.routingFreeze.findUnique.mockResolvedValue(null);
    const result = await h.controller.getFreeze();
    expect(result.frozen).toBe(false);
  });
});
