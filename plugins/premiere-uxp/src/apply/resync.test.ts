import { describe, expect, it } from "vitest";

import { resync } from "./resync.js";
import { MockPremiereHost } from "../host/premiere.js";

describe("resync", () => {
  it("removes items whose segment no longer exists at the new revision", async () => {
    const host = new MockPremiereHost();
    await host.setItemMetadata("item-1", {
      aksharo: { projectId: "p1", segmentId: "seg-1", rev: 1 },
    });
    await host.setItemMetadata("item-2", {
      aksharo: { projectId: "p1", segmentId: "seg-2", rev: 1 },
    });

    const result = await resync(host, {
      projectId: "p1",
      revision: 1,
      liveSegmentIds: ["seg-1"],
    });

    expect(result.removed).toEqual(["item-2"]);
    await expect(host.getItemMetadata("item-2")).resolves.toBeUndefined();
    await expect(host.getItemMetadata("item-1")).resolves.toBeDefined();
  });

  it("reports items behind the current revision as stale, others as up to date", async () => {
    const host = new MockPremiereHost();
    await host.setItemMetadata("item-1", {
      aksharo: { projectId: "p1", segmentId: "seg-1", rev: 1 },
    });
    await host.setItemMetadata("item-2", {
      aksharo: { projectId: "p1", segmentId: "seg-2", rev: 3 },
    });

    const result = await resync(host, {
      projectId: "p1",
      revision: 3,
      liveSegmentIds: ["seg-1", "seg-2"],
    });

    expect(result.stale).toEqual(["item-1"]);
    expect(result.upToDate).toEqual(["item-2"]);
    expect(result.removed).toEqual([]);
  });

  it("ignores items belonging to a different project", async () => {
    const host = new MockPremiereHost();
    await host.setItemMetadata("item-1", {
      aksharo: { projectId: "other-project", segmentId: "seg-1", rev: 1 },
    });

    const result = await resync(host, { projectId: "p1", revision: 5, liveSegmentIds: [] });

    expect(result).toEqual({ removed: [], stale: [], upToDate: [] });
    await expect(host.getItemMetadata("item-1")).resolves.toBeDefined();
  });

  it("treats an item with no segmentId (e.g. the transcript item) as never removable by id-diff", async () => {
    const host = new MockPremiereHost();
    await host.setItemMetadata("transcript-1", { aksharo: { projectId: "p1", rev: 1 } });

    const result = await resync(host, { projectId: "p1", revision: 2, liveSegmentIds: [] });

    expect(result.removed).toEqual([]);
    expect(result.stale).toEqual(["transcript-1"]);
  });
});
