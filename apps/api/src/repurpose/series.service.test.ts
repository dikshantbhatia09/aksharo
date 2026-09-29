import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";
import type { EdgOp, Overlay } from "@montaj/edg/schemas";

import { SERIES_ERRORS } from "./compilations.dto.js";
import { seriesLabelIds } from "./series-labels.js";
import { RepurposeSeriesService, labelEntriesOf } from "./series.service.js";

const WS = "01JCWS0000000000000000000A";
const USER = "01JCUSER000000000000000000";
const RUN = "01JCRN0000000000000000000A";
const CLIPS = [
  "01JCC11PA00000000000000000",
  "01JCC11PB00000000000000000",
  "01JCC11PC00000000000000000",
];

type Row = Record<string, unknown>;

interface Doc {
  id: string;
  revision: number;
  overlays: Overlay[];
  durationMs: number;
}

let clips: Row[];
let variants: Row[];
let series: Row[];
let docs: Map<string, Doc>;
let failing: Set<string>;
let audit: { record: ReturnType<typeof vi.fn> };

function variantId(clip: number, shape: "v" | "s"): string {
  return `01JCVAR${shape === "v" ? "V" : "S"}${String(clip).padStart(18, "0")}`;
}
function projectId(clip: number, shape: "v" | "s"): string {
  return `01JCPR0J${shape === "v" ? "V" : "S"}${String(clip).padStart(17, "0")}`;
}

function matches(row: Row, where: Row | undefined): boolean {
  const fields = new Map(Object.entries(row));
  for (const [key, condition] of Object.entries(where ?? {})) {
    const value = fields.get(key);
    if (condition !== null && typeof condition === "object" && "in" in (condition as Row)) {
      if (!(condition as { in: unknown[] }).in.includes(value)) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function prisma() {
  return {
    repurposeRun: {
      findFirst: vi.fn(async () => ({ id: RUN, workspaceId: WS })),
    },
    repurposeClip: {
      findMany: vi.fn(async (args: { where: Row }) =>
        clips.filter((row) => matches(row, args.where)),
      ),
    },
    clipVariant: {
      findMany: vi.fn(async (args: { where: Row }) =>
        variants.filter((row) => matches(row, args.where)),
      ),
    },
    repurposeSeries: {
      findMany: vi.fn(async (args: { where: Row }) =>
        series.filter((row) => matches(row, args.where)),
      ),
      findFirst: vi.fn(
        async (args: { where: Row }) => series.find((row) => matches(row, args.where)) ?? null,
      ),
      findUniqueOrThrow: vi.fn(async (args: { where: Row }) => {
        const row = series.find((entry) => matches(entry, args.where));
        if (row === undefined) throw new Error("not found");
        return row;
      }),
      create: vi.fn(async (args: { data: Row }) => {
        const row = { createdAt: new Date(), ...args.data };
        series.push(row);
        return row;
      }),
      update: vi.fn(async (args: { where: Row; data: Row }) => {
        const row = series.find((entry) => matches(entry, args.where));
        if (row === undefined) throw new Error("not found");
        Object.assign(row, args.data);
        return row;
      }),
      deleteMany: vi.fn(async (args: { where: Row }) => {
        series = series.filter((row) => !matches(row, args.where));
        return { count: 1 };
      }),
    },
    edgDocument: {
      findUnique: vi.fn(async (args: { where: { projectId: string } }) => {
        const doc = docs.get(args.where.projectId);
        return doc === undefined ? null : { id: doc.id, revision: doc.revision };
      }),
    },
  };
}

const edgRepository = {
  projectionOf: vi.fn(async (edgId: string) => {
    const doc = [...docs.values()].find((entry) => entry.id === edgId);
    if (doc === undefined) throw new Error("no document");
    return {
      overlays: doc.overlays,
      passes: [],
      media: [{ role: "primary", durationMs: doc.durationMs }],
    };
  }),
};

/** Applies overlay ops the way the document engine would, for these two op kinds. */
const edg = {
  applyWorkerOps: vi.fn(async (input: { projectId: string; ops: readonly EdgOp[] }) => {
    if (failing.has(input.projectId)) throw new Error("document refused");
    const doc = docs.get(input.projectId);
    if (doc === undefined) throw new Error("no document");
    for (const op of input.ops) {
      if (op.type === "RemoveOverlay")
        doc.overlays = doc.overlays.filter((o) => o.id !== op.overlayId);
      if (op.type === "SetOverlay") {
        doc.overlays = [...doc.overlays.filter((o) => o.id !== op.overlay.id), op.overlay];
      }
    }
    doc.revision += 1;
    return {
      revision: doc.revision,
      applied: input.ops.map((op) => op.opId),
      rebased: [],
      rejected: [],
    };
  }),
};

function service(): RepurposeSeriesService {
  return new RepurposeSeriesService(
    prisma() as never,
    edg as never,
    edgRepository as never,
    {
      forWorkspace: vi.fn(async () => ({ entitlements: { flags: { repurpose_flow: true } } })),
    } as never,
    audit as never,
    { FEATURE_FLAGS_JSON: {} } as unknown as Env,
  );
}

function hook(id: string): Overlay {
  return { id, kind: "hook-title", text: "Autopilot hook", startMs: 0, endMs: 2_500 };
}

beforeEach(() => {
  failing = new Set();
  audit = { record: vi.fn(async () => undefined) };
  // Given in the order the person ticked them; they play C, A, B in the video.
  clips = [
    {
      id: CLIPS[0],
      runId: RUN,
      mezzanineKey: "m",
      sourceStartMs: 60_000,
      createdAt: new Date(1),
      candidate: { state: "materialized" },
    },
    {
      id: CLIPS[1],
      runId: RUN,
      mezzanineKey: "m",
      sourceStartMs: 90_000,
      createdAt: new Date(2),
      candidate: { state: "materialized" },
    },
    {
      id: CLIPS[2],
      runId: RUN,
      mezzanineKey: "m",
      sourceStartMs: 10_000,
      createdAt: new Date(3),
      candidate: { state: "materialized" },
    },
  ];
  variants = [];
  docs = new Map();
  CLIPS.forEach((clipId, index) => {
    for (const shape of ["v", "s"] as const) {
      const id = variantId(index, shape);
      variants.push({
        id,
        clipId,
        projectId: projectId(index, shape),
        // The square shape is still being finished.
        finishing:
          shape === "v"
            ? { v: 1, state: "done", startedAt: "x", steps: {} }
            : { v: 1, state: "running", startedAt: "x", steps: {} },
      });
      docs.set(projectId(index, shape), {
        id: `01JCD0C${shape.toUpperCase()}${String(index).padStart(18, "0")}`,
        revision: 3,
        overlays: [hook(id)],
        durationMs: 30_000,
      });
    }
  });
  series = [];
});

describe("RepurposeSeriesService (2026-10-03)", () => {
  it("numbers the clips in the order they play, and labels every finished shape", async () => {
    const view = await service().create(WS, USER, RUN, { clipIds: [...CLIPS] });
    expect(view.clipIds).toEqual([CLIPS[2], CLIPS[0], CLIPS[1]]);
    expect(view.parts).toEqual([
      { clipId: CLIPS[2], part: 1, labelled: 1, pending: 1 },
      { clipId: CLIPS[0], part: 2, labelled: 1, pending: 1 },
      { clipId: CLIPS[1], part: 3, labelled: 1, pending: 1 },
    ]);

    // Clip C plays first: part 1, with what comes next; Autopilot's hook gave way.
    const first = docs.get(projectId(2, "v"));
    const ids = seriesLabelIds(variantId(2, "v"));
    expect(first?.overlays.map((overlay) => overlay.id).sort()).toEqual(
      [ids.part, ids.next].sort(),
    );
    expect(first?.overlays.find((overlay) => overlay.id === ids.part)).toMatchObject({
      text: "Part 1 of 3",
    });
    expect(first?.overlays.find((overlay) => overlay.id === ids.next)).toMatchObject({
      text: "Part 2 next",
    });
    // The last part says nothing of a next one.
    const last = docs.get(projectId(1, "v"));
    expect(last?.overlays.map((overlay) => "text" in overlay && overlay.text)).toEqual([
      "Part 3 of 3",
    ]);
    // A shape still being finished is left alone for now.
    expect(docs.get(projectId(0, "s"))?.overlays).toEqual([hook(variantId(0, "s"))]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repurpose.series.created" }),
    );
  });

  it("labels a shape once it is finished, on the run's reconcile", async () => {
    await service().create(WS, USER, RUN, { clipIds: [...CLIPS] });
    for (const variant of variants)
      variant["finishing"] = { v: 1, state: "done", startedAt: "x", steps: {} };
    await service().reconcile(RUN);
    const [record] = series;
    expect(labelEntriesOf(record?.["labels"])).toHaveLength(6);
    expect(
      docs
        .get(projectId(0, "s"))
        ?.overlays.some((overlay) => "text" in overlay && overlay.text === "Part 2 of 3"),
    ).toBe(true);
    // Asked again, nothing is labelled twice.
    const writes = edg.applyWorkerOps.mock.calls.length;
    await service().reconcile(RUN);
    expect(edg.applyWorkerOps.mock.calls.length).toBe(writes);
  });

  it("takes every label off and puts Autopilot's hooks back", async () => {
    const view = await service().create(WS, USER, RUN, { clipIds: [...CLIPS] });
    const removed = await service().remove(WS, USER, RUN, view.id);
    expect(removed).toEqual({ id: view.id, restored: 3 });
    for (const index of [0, 1, 2]) {
      expect(docs.get(projectId(index, "v"))?.overlays).toEqual([hook(variantId(index, "v"))]);
    }
    expect(series).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repurpose.series.removed" }),
    );
  });

  it("refuses a clip not made yet, or a removed moment's", async () => {
    (clips[1] as Row)["mezzanineKey"] = null;
    await expect(service().create(WS, USER, RUN, { clipIds: [...CLIPS] })).rejects.toMatchObject({
      code: SERIES_ERRORS.clipsNotReady,
      details: { clipIds: [CLIPS[1]] },
    });
    (clips[1] as Row)["mezzanineKey"] = "m";
    (clips[2] as Row)["candidate"] = { state: "rejected" };
    await expect(service().create(WS, USER, RUN, { clipIds: [...CLIPS] })).rejects.toMatchObject({
      code: SERIES_ERRORS.clipsNotReady,
    });
    expect(series).toEqual([]);
  });

  it("keeps a clip to one series at a time", async () => {
    await service().create(WS, USER, RUN, { clipIds: [CLIPS[0] as string, CLIPS[1] as string] });
    await expect(
      service().create(WS, USER, RUN, { clipIds: [CLIPS[1] as string, CLIPS[2] as string] }),
    ).rejects.toMatchObject({ code: SERIES_ERRORS.clipTaken, details: { clipIds: [CLIPS[1]] } });
  });

  it("labels the rest when one shape's document refuses, and tries that one again", async () => {
    failing.add(projectId(0, "v"));
    const view = await service().create(WS, USER, RUN, { clipIds: [...CLIPS] });
    expect(view.parts.find((part) => part.clipId === CLIPS[0])).toMatchObject({ labelled: 0 });
    expect(view.parts.find((part) => part.clipId === CLIPS[2])).toMatchObject({ labelled: 1 });
    failing.clear();
    await service().reconcile(RUN);
    expect(labelEntriesOf(series[0]?.["labels"]).map((entry) => entry.variantId)).toContain(
      variantId(0, "v"),
    );
  });
});
