import { describe, expect, it, vi } from "vitest";

import { RetentionService } from "./retention.service.js";
import { asMock, callArg } from "../../test/mock-args.js";

import type { PrismaService } from "../common/index.js";
import type { ObjectStore } from "../common/storage/index.js";

const NOW = new Date("2026-09-10T00:00:00.000Z");

interface DueRaw {
  id: string;
  storageKey: string;
}

interface DueDerived {
  id: string;
  bucket: "s3" | "r2";
  storageKey: string;
  proxyKey: string | null;
  audio16kKey: string | null;
  audio48kKey: string | null;
  waveformKey: string | null;
  facesKey: string | null;
  thumbKeys: string[];
}

function makeService(rows: { raw?: DueRaw[]; derived?: DueDerived[] } = {}) {
  const prisma = {
    mediaAsset: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        "rawPurgeAt" in where ? (rows.raw ?? []) : (rows.derived ?? []),
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
  };
  const raw = {
    kind: "s3" as const,
    bucket: "montaj-raw",
    delete: vi.fn(async () => undefined),
    deleteMany: vi.fn(async (keys: readonly string[]) => keys.length),
  } as unknown as ObjectStore & Record<string, ReturnType<typeof vi.fn>>;
  const derived = {
    kind: "r2" as const,
    bucket: "montaj-derived",
    delete: vi.fn(async () => undefined),
    deleteMany: vi.fn(async (keys: readonly string[]) => keys.length),
  } as unknown as ObjectStore & Record<string, ReturnType<typeof vi.fn>>;

  const service = new RetentionService(prisma as unknown as PrismaService, raw, derived);
  return { service, prisma, raw, derived };
}

const RAW_DUE: DueRaw[] = [
  { id: "m1", storageKey: "ws/a/p/b/media/m1/raw.mp4" },
  { id: "m2", storageKey: "ws/a/p/b/media/m2/raw.mov" },
];

const DERIVED_DUE: DueDerived[] = [
  {
    id: "m3",
    bucket: "s3",
    storageKey: "ws/a/p/b/media/m3/raw.mp4",
    proxyKey: "ws/a/p/b/media/m3/proxy540.mp4",
    audio16kKey: "ws/a/p/b/media/m3/audio16k.wav",
    audio48kKey: null,
    waveformKey: "ws/a/p/b/media/m3/waveform.json",
    facesKey: "ws/a/p/b/media/m3/faces.json",
    thumbKeys: ["ws/a/p/b/media/m3/thumb-0.jpg"],
  },
];

describe("purgeDueMedia — raw (D47)", () => {
  it("deletes the raw objects that are due and leaves derived ones alone", async () => {
    const { service, raw, derived, prisma } = makeService({ raw: RAW_DUE });
    const report = await service.purgeDueMedia({ now: NOW });

    expect(raw.delete).toHaveBeenCalledTimes(2);
    expect(raw.delete).toHaveBeenCalledWith("ws/a/p/b/media/m1/raw.mp4");
    // Nothing on the derived store was touched: the two clocks are independent.
    expect(derived.deleteMany).not.toHaveBeenCalled();
    expect(report.rawPurged).toBe(2);
    expect(report.derivedPurged).toBe(0);

    // The row is marked only after the store confirms.
    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["m1", "m2"] } },
      data: { rawPurgedAt: NOW },
    });
  });

  it("selects only rows past `rawPurgeAt` that have not already been swept", async () => {
    const { service, prisma } = makeService({ raw: [] });
    await service.purgeDueMedia({ now: NOW, limit: 10 });
    const where = callArg(prisma.mediaAsset.findMany, 0, 0).where as Record<string, unknown>;
    expect(where).toEqual({ rawPurgeAt: { lte: NOW }, rawPurgedAt: null, bucket: "s3" });
    expect(callArg(prisma.mediaAsset.findMany, 0, 0).take).toBe(10);
  });

  it("leaves a row unmarked when the store refuses, so the next pass retries it", async () => {
    const { service, raw, prisma } = makeService({ raw: RAW_DUE });
    asMock(raw.delete).mockRejectedValueOnce(new Error("AccessDenied"));

    const report = await service.purgeDueMedia({ now: NOW });
    expect(report.failed).toBe(1);
    expect(report.rawPurged).toBe(1);
    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["m2"] } },
      data: { rawPurgedAt: NOW },
    });
  });

  it("writes nothing when nothing was due", async () => {
    const { service, prisma } = makeService();
    const report = await service.purgeDueMedia({ now: NOW });
    expect(report).toMatchObject({ rawPurged: 0, derivedPurged: 0, failed: 0 });
    expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
  });
});

describe("purgeDueMedia — derived", () => {
  it("deletes every derived artefact and clears the keys", async () => {
    const { service, derived, prisma } = makeService({ derived: DERIVED_DUE });
    const report = await service.purgeDueMedia({ now: NOW });

    expect(derived.deleteMany).toHaveBeenCalledWith([
      "ws/a/p/b/media/m3/proxy540.mp4",
      "ws/a/p/b/media/m3/audio16k.wav",
      "ws/a/p/b/media/m3/waveform.json",
      "ws/a/p/b/media/m3/faces.json",
      "ws/a/p/b/media/m3/thumb-0.jpg",
    ]);
    expect(report.derivedPurged).toBe(1);
    expect(report.derivedObjects).toBe(5);

    const data = callArg(prisma.mediaAsset.update, 0, 0).data as Record<string, unknown>;
    expect(data).toMatchObject({
      derivedPurgedAt: NOW,
      proxyKey: null,
      audio16kKey: null,
      waveformKey: null,
      facesKey: null,
      thumbKeys: [],
    });
    // A raw-bucket row is not marked purged: its original may still be there.
    expect(data["status"]).toBeUndefined();
  });

  it("also deletes an imported subtitle sidecar, which IS its own derived object", async () => {
    const sidecar: DueDerived = {
      id: "m4",
      bucket: "r2",
      storageKey: "ws/a/p/b/media/m4/subtitle.json",
      proxyKey: null,
      audio16kKey: null,
      audio48kKey: null,
      waveformKey: null,
      facesKey: null,
      thumbKeys: [],
    };
    const { service, derived, prisma } = makeService({ derived: [sidecar] });
    await service.purgeDueMedia({ now: NOW });

    expect(derived.deleteMany).toHaveBeenCalledWith(["ws/a/p/b/media/m4/subtitle.json"]);
    const data = callArg(prisma.mediaAsset.update, 0, 0).data as Record<string, unknown>;
    expect(data["status"]).toBe("purged");
  });

  it("counts a failure instead of throwing, so one bad row cannot stop the sweep", async () => {
    const { service, derived } = makeService({ derived: DERIVED_DUE });
    asMock(derived.deleteMany).mockRejectedValueOnce(new Error("boom"));
    const report = await service.purgeDueMedia({ now: NOW });
    expect(report.failed).toBe(1);
    expect(report.derivedPurged).toBe(0);
  });
});
