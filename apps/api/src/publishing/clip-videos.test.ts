import { describe, expect, it } from "vitest";

import { artifactFingerprint, clipVideos } from "./clip-videos.js";
import { MemoryPrisma } from "./memory-prisma.test-support.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";

const CLIP = "01JCC11PA00000000000000000";

function exportRow(id: string, projectId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    projectId,
    status: "succeeded",
    kind: "mp4",
    storageKey: `ws/${projectId}/exports/${id}.mp4`,
    bucket: "r2",
    sizeBytes: BigInt(1_000),
    durationMs: 30_000,
    createdAt: new Date("2026-09-30T10:00:00Z"),
    ...over,
  };
}

describe("clipVideos", () => {
  it("reads Autopilot's renders: ready posts, rendering or stale waits, failed does not", async () => {
    const db = new MemoryPrisma();
    db.tables.clipVariant.push(
      {
        id: "V1",
        clipId: CLIP,
        projectId: "P1",
        aspect: "r9x16",
        status: "ready",
        latestExportId: "E1",
      },
      {
        id: "V2",
        clipId: CLIP,
        projectId: "P2",
        aspect: "r4x5",
        status: "stale",
        latestExportId: "E2",
      },
      {
        id: "V3",
        clipId: CLIP,
        projectId: "P3",
        aspect: "r1x1",
        status: "failed",
        latestExportId: null,
      },
    );
    db.tables.export.push(exportRow("E1", "P1"), exportRow("E2", "P2"));
    const videos = await clipVideos(db as unknown as PrismaService, CLIP);
    expect(videos.get("9:16")).toMatchObject({
      state: "ready",
      variantId: "V1",
      export: { id: "E1", storageKey: "ws/P1/exports/E1.mp4", sizeBytes: 1_000 },
    });
    // An edit is waiting to be rendered: the old file is not what the person sees now.
    expect(videos.get("4:5")).toMatchObject({ state: "making", export: null });
    expect(videos.get("1:1")).toMatchObject({ state: "failed", export: null });
    expect(videos.has("16:9")).toBe(false);
  });

  it("takes a hand-made export when it is newer than the last caption edit", async () => {
    const db = new MemoryPrisma();
    db.tables.clipVariant.push({
      id: "V1",
      clipId: CLIP,
      projectId: "P1",
      aspect: "r9x16",
      status: "preparing",
      latestExportId: null,
    });
    db.tables.export.push(
      exportRow("E-old", "P1", { createdAt: new Date("2026-09-30T08:00:00Z") }),
      exportRow("E-new", "P1", { createdAt: new Date("2026-09-30T12:00:00Z") }),
      exportRow("E-srt", "P1", { kind: "srt", createdAt: new Date("2026-09-30T13:00:00Z") }),
    );
    db.tables.edgDocument.push({ projectId: "P1", updatedAt: new Date("2026-09-30T11:00:00Z") });
    const current = await clipVideos(db as unknown as PrismaService, CLIP);
    expect(current.get("9:16")).toMatchObject({ state: "ready", export: { id: "E-new" } });

    // Captions edited after the newest export: that video is out of date.
    (db.tables.edgDocument[0] as Record<string, unknown>)["updatedAt"] = new Date(
      "2026-09-30T12:30:00Z",
    );
    const stale = await clipVideos(db as unknown as PrismaService, CLIP);
    expect(stale.get("9:16")).toMatchObject({ state: "stale", export: null });
  });

  it("has nothing to post from a clean cut alone", async () => {
    const db = new MemoryPrisma();
    db.tables.clipVariant.push({
      id: "V1",
      clipId: CLIP,
      projectId: "P1",
      aspect: "r9x16",
      status: "preparing",
      latestExportId: null,
    });
    const videos = await clipVideos(db as unknown as PrismaService, CLIP);
    expect(videos.get("9:16")).toMatchObject({ state: "none", export: null });
  });
});

describe("artifactFingerprint", () => {
  it("changes when the file behind the export changes", () => {
    const a = artifactFingerprint({ id: "E1", storageKey: "k1", sizeBytes: 10 });
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(artifactFingerprint({ id: "E1", storageKey: "k2", sizeBytes: 10 })).not.toBe(a);
    expect(artifactFingerprint({ id: "E1", storageKey: "k1", sizeBytes: 10 })).toBe(a);
  });
});
