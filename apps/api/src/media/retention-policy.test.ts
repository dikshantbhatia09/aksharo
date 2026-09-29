import { describe, expect, it, vi } from "vitest";

import {
  notExemptWorkspace,
  retentionExemptWorkspaceIds,
  retentionPurgesDerived,
} from "./retention-policy.js";
import { RetentionService } from "./retention.service.js";
import { callArg } from "../../test/mock-args.js";

import type { PrismaService } from "../common/index.js";
import type { ObjectStore } from "../common/storage/index.js";

const OWNER = "01M1KFX35NJRD5N58H0J6YGAPC";
const NOW = new Date("2026-09-29T00:00:00.000Z");

describe("retention policy switches", () => {
  it("reads the exempt workspaces as a trimmed, deduplicated comma list", () => {
    expect(retentionExemptWorkspaceIds({})).toEqual([]);
    expect(retentionExemptWorkspaceIds({ RETENTION_EXEMPT_WORKSPACE_IDS: "" })).toEqual([]);
    expect(
      retentionExemptWorkspaceIds({ RETENTION_EXEMPT_WORKSPACE_IDS: ` ${OWNER}, ,${OWNER},ws2 ` }),
    ).toEqual([OWNER, "ws2"]);
  });

  it("purges derived files unless the switch says no", () => {
    expect(retentionPurgesDerived({})).toBe(true);
    expect(retentionPurgesDerived({ RETENTION_PURGE_DERIVED: "1" })).toBe(true);
    for (const off of ["0", "false", "no", "off", " OFF "]) {
      expect(retentionPurgesDerived({ RETENTION_PURGE_DERIVED: off })).toBe(false);
    }
  });

  it("adds no filter when nobody is exempt", () => {
    expect(notExemptWorkspace([])).toEqual({});
    expect(notExemptWorkspace([OWNER])).toEqual({ workspaceId: { notIn: [OWNER] } });
  });
});

describe("purgeDueMedia with the owner exempt and derived files kept", () => {
  function makeService() {
    const prisma = {
      mediaAsset: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
        update: vi.fn(async () => ({})),
      },
    };
    const store = {
      delete: vi.fn(async () => undefined),
      deleteMany: vi.fn(async () => 0),
    } as unknown as ObjectStore;
    return {
      prisma,
      service: new RetentionService(prisma as unknown as PrismaService, store, store),
    };
  }

  it("never selects media in an exempt workspace", async () => {
    const { service, prisma } = makeService();
    await service.purgeDueMedia({ now: NOW, exemptWorkspaceIds: [OWNER] });
    const rawWhere = callArg(prisma.mediaAsset.findMany, 0, 0).where as Record<string, unknown>;
    const derivedWhere = callArg(prisma.mediaAsset.findMany, 1, 0).where as Record<string, unknown>;
    expect(rawWhere["project"]).toEqual({ workspaceId: { notIn: [OWNER] } });
    expect(derivedWhere["project"]).toEqual({ workspaceId: { notIn: [OWNER] } });
  });

  it("leaves derived files alone when derived purging is off, and still purges originals", async () => {
    const { service, prisma } = makeService();
    const report = await service.purgeDueMedia({ now: NOW, purgeDerived: false });
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledTimes(1);
    const where = callArg(prisma.mediaAsset.findMany, 0, 0).where as Record<string, unknown>;
    expect(where).toHaveProperty("rawPurgeAt");
    expect(report.derivedPurged).toBe(0);
  });
});
