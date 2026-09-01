import { describe, expect, it, vi } from "vitest";

import { resolveWorkspacePlan } from "./plan.js";

import type { PlanLookupClient } from "./plan.js";

function client(result: unknown): {
  prisma: PlanLookupClient;
  findFirst: ReturnType<typeof vi.fn>;
} {
  const findFirst = vi.fn().mockResolvedValue(result);
  return { prisma: { subscription: { findFirst } } as unknown as PlanLookupClient, findFirst };
}

describe("resolveWorkspacePlan", () => {
  it("returns the plan of a live subscription", async () => {
    const { prisma } = client({ plan: { key: "studio" } });
    await expect(resolveWorkspacePlan(prisma, "ws")).resolves.toBe("studio");
  });

  it("falls back to free when there is no live subscription", async () => {
    const { prisma } = client(null);
    await expect(resolveWorkspacePlan(prisma, "ws")).resolves.toBe("free");
  });

  it("only counts subscriptions that still entitle the workspace", async () => {
    const { prisma, findFirst } = client(null);
    await resolveWorkspacePlan(prisma, "ws");
    const where = findFirst.mock.calls[0]?.[0]?.where as { status: { in: string[] } };
    expect(where.status.in).toEqual(["trialing", "active", "past_due", "paused"]);
    // Cancelled and expired must not appear: a lookup failure has to narrow the
    // caps, never widen them.
    expect(where.status.in).not.toContain("cancelled");
    expect(where.status.in).not.toContain("expired");
  });
});
