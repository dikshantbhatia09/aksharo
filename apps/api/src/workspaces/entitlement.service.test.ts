import { describe, expect, it, vi } from "vitest";

import {
  EntitlementService,
  INTERNAL_UNLIMITED_ENTITLEMENTS,
  INTERNAL_UNLIMITED_ENV,
  internalUnlimitedWorkspaceIds,
  withInternalOverride,
} from "./entitlement.service.js";
import { workspacesRedisKeys } from "./workspaces.constants.js";
import { clipsLimitsFor, mediaLimitsFor } from "../projects/plan-limits.js";

import type { EntitlementView } from "./entitlement.service.js";

const OWNER = "01M1KFX35NJRD5N58H0J6YGAPC";
const OTHER = "01JCWS0000000000000000000B";
const HOUR = 60 * 60_000;

const STUDIO = {
  maxFileBytes: 8 * 1024 ** 3,
  maxDurationMs: 6 * HOUR,
  clipsWindowMs: 6 * HOUR,
  maxSourceDurationMs: 12 * HOUR,
  passes: { proEngine: true },
  queuePriority: "highest",
};

function view(
  workspaceId: string,
  entitlements: Record<string, unknown> = STUDIO,
): EntitlementView {
  return {
    workspaceId,
    planKey: "studio",
    planName: "Studio",
    creditsPerMonthTenths: 18_000,
    seatsIncluded: 3,
    seatsUsed: 1,
    entitlements,
    computedAt: "2026-09-27T00:00:00.000Z",
  };
}

describe("internalUnlimitedWorkspaceIds", () => {
  it("reads a comma list, trimmed, ignoring blanks", () => {
    expect([
      ...internalUnlimitedWorkspaceIds({ [INTERNAL_UNLIMITED_ENV]: ` ${OWNER} ,, ${OTHER},` }),
    ]).toEqual([OWNER, OTHER]);
  });

  it("is nobody when unset or empty", () => {
    expect(internalUnlimitedWorkspaceIds({}).size).toBe(0);
    expect(internalUnlimitedWorkspaceIds({ [INTERNAL_UNLIMITED_ENV]: "  " }).size).toBe(0);
  });
});

describe("withInternalOverride — the owner's workspaces are not held to a plan's numbers", () => {
  const env = { [INTERNAL_UNLIMITED_ENV]: OWNER };

  it("lifts the four size and length numbers to the 12-hour, 50 GiB ceiling", () => {
    const lifted = withInternalOverride(view(OWNER), env);
    expect(clipsLimitsFor(lifted)).toMatchObject({
      clipsWindowMs: 12 * HOUR,
      maxSourceDurationMs: 12 * HOUR,
      maxFileBytes: 50 * 1024 ** 3,
    });
    expect(mediaLimitsFor(lifted).maxDurationMs).toBe(12 * HOUR);
    expect(lifted.entitlements["internalUnlimited"]).toBe(true);
    expect(INTERNAL_UNLIMITED_ENTITLEMENTS).toEqual({
      clipsWindowMs: 12 * HOUR,
      maxSourceDurationMs: 12 * HOUR,
      maxDurationMs: 12 * HOUR,
      maxFileBytes: 50 * 1024 ** 3,
    });
  });

  it("keeps the plan, its lane, credits and features as the subscription says", () => {
    const lifted = withInternalOverride(view(OWNER), env);
    expect(lifted.planKey).toBe("studio");
    expect(lifted.creditsPerMonthTenths).toBe(18_000);
    expect(lifted.entitlements["passes"]).toEqual({ proEngine: true });
    expect(lifted.entitlements["queuePriority"]).toBe("highest");
  });

  it("leaves every other workspace exactly as its plan says", () => {
    const other = view(OTHER);
    expect(withInternalOverride(other, env)).toBe(other);
  });
});

describe("EntitlementService — the override and the cache", () => {
  function harness(cached: EntitlementView | null) {
    const store = new Map<string, string>();
    if (cached !== null) {
      store.set(workspacesRedisKeys.entitlement(cached.workspaceId), JSON.stringify(cached));
    }
    const set = vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    });
    const redis = {
      client: {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        set,
        del: vi.fn(async () => 1),
      },
    };
    const service = new EntitlementService({} as never, redis as never);
    return { service, set };
  }

  it("applies to a snapshot cached before the workspace was listed, without waiting for it to expire", async () => {
    vi.stubEnv(INTERNAL_UNLIMITED_ENV, OWNER);
    try {
      const { service } = harness(view(OWNER));
      const answer = await service.forWorkspace(OWNER);
      expect(clipsLimitsFor(answer).clipsWindowMs).toBe(12 * HOUR);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is never written into the cache: taking a workspace off the list takes effect at once", async () => {
    const { service, set } = harness(null);
    const compute = vi
      .spyOn(service as unknown as { compute: (id: string) => Promise<EntitlementView> }, "compute")
      .mockResolvedValue(view(OWNER));

    vi.stubEnv(INTERNAL_UNLIMITED_ENV, OWNER);
    try {
      const lifted = await service.forWorkspace(OWNER);
      expect(clipsLimitsFor(lifted).clipsWindowMs).toBe(12 * HOUR);
      const written = JSON.parse(set.mock.calls[0]?.[1] ?? "{}") as EntitlementView;
      expect(written.entitlements["clipsWindowMs"]).toBe(6 * HOUR);
      expect(written.entitlements).not.toHaveProperty("internalUnlimited");
    } finally {
      vi.unstubAllEnvs();
    }

    // Off the list: the very next read (served from that cache) is the plan's.
    const after = await service.forWorkspace(OWNER);
    expect(clipsLimitsFor(after).clipsWindowMs).toBe(6 * HOUR);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
