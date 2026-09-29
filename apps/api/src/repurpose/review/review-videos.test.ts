import { describe, expect, it } from "vitest";

import {
  IDS,
  ReviewMemory,
  renderClip,
  seedClip,
  seedWorkspace,
} from "./review-memory.test-support.js";
import { reviewVideosOf } from "./review-videos.js";

function db(): ReviewMemory {
  const memory = new ReviewMemory();
  seedWorkspace(memory);
  return memory;
}

describe("the video a review is about", () => {
  it("is Autopilot's render once it is made, per shape", async () => {
    const memory = db();
    const clip = seedClip(memory, 1, { rendered: ["9:16", "1:1"] });
    const videos = (await reviewVideosOf(memory.prisma, [clip])).get(clip);
    expect([...(videos?.keys() ?? [])].sort()).toEqual(["1:1", "9:16"]);
    const vertical = videos?.get("9:16");
    expect(vertical?.storageKey).toContain(`ws/${IDS.ws}/`);
    expect(vertical?.durationMs).toBe(30_000);
  });

  it("is the previous file while a newer render is still being made", async () => {
    const memory = db();
    const clip = seedClip(memory, 1);
    const first = (await reviewVideosOf(memory.prisma, [clip])).get(clip)?.get("9:16")?.exportId;
    const fresh = renderClip(memory, clip, "9:16");
    const row = memory.tables.export.find((entry) => entry["id"] === fresh);
    if (row !== undefined) {
      row["status"] = "rendering";
      row["storageKey"] = null;
    }
    expect((await reviewVideosOf(memory.prisma, [clip])).get(clip)?.get("9:16")?.exportId).toBe(
      first,
    );
    // Once it lands, it is the one.
    if (row !== undefined) {
      row["status"] = "succeeded";
      row["storageKey"] = "ws/x/exports/fresh.mp4";
    }
    expect((await reviewVideosOf(memory.prisma, [clip])).get(clip)?.get("9:16")?.exportId).toBe(
      fresh,
    );
  });

  it("is the newest finished MP4 of a shape exported by hand", async () => {
    const memory = db();
    const clip = seedClip(memory, 1);
    const variant = memory.tables.clipVariant[0];
    if (variant !== undefined) variant["latestExportId"] = null;
    const newest = renderClip(memory, clip, "9:16");
    if (variant !== undefined) variant["latestExportId"] = null;
    memory.tables.export.push({
      id: "SRT-EXPORT",
      projectId: variant?.["projectId"],
      status: "succeeded",
      kind: "srt",
      storageKey: "ws/x/exports/subs.srt",
      durationMs: null,
      createdAt: new Date("2030-01-01T00:00:00Z"),
    });
    expect((await reviewVideosOf(memory.prisma, [clip])).get(clip)?.get("9:16")?.exportId).toBe(
      newest,
    );
  });

  it("is nothing for a shape whose file retention has deleted", async () => {
    const memory = db();
    const clip = seedClip(memory, 1);
    for (const row of memory.tables.export) row["storageKey"] = null;
    expect((await reviewVideosOf(memory.prisma, [clip])).has(clip)).toBe(false);
    expect((await reviewVideosOf(memory.prisma, [])).size).toBe(0);
  });
});
