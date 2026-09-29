import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyOps, fromProjection, newId, toProjection, type EdgState } from "@montaj/edg";
import type { EdgOp, Pass, PassItem, TranscriptChunk, WordId } from "@montaj/edg/schemas";

import {
  acceptableCut,
  ClipFinishing,
  FINISHING_MAX_MS,
  finishingInProgress,
  finishingRecordOf,
  HOOK_TITLE_MS,
  hookTextOf,
  hookWindow,
  keywordPresetId,
  type FinishingVariant,
} from "./clip-finishing.js";
import { AppException } from "../common/index.js";
import { JOB_ERROR_CODES } from "../jobs/jobs.errors.js";

import type { RepurposeRun } from "@prisma/client";

const WS = "01JFWS0000000000000000000A";
const RUN_ID = "01JFRN0000000000000000000A";
const CLIP = "01JFC11P00000000000000000A";
const VERTICAL = "01JFVAR9X16000000000000000";
const SQUARE = "01JFVAR1X10000000000000000";
const WIDE = "01JFVAR16X9000000000000000";
const PROJECT_9X16 = "01JFPR9X1600000000000000AA";
const PROJECT_1X1 = "01JFPR1X1000000000000000AA";
const PROJECT_16X9 = "01JFPR16X900000000000000AA";
const TRANSCRIPT = "01JFTRANSCR1PT000000000000";
const CUT_PASS = "01JFPASSCVT000000000000000";
const ZOOM_PASS = "01JFPASSZ00M000000000000000".slice(0, 26);
const CUT_JOB = "01JFJ0BCVT0000000000000000";
const ZOOM_JOB = "01JFJ0BZ00M000000000000000";

const RUN = {
  id: RUN_ID,
  workspaceId: WS,
  createdBy: "01JFUSER000000000000000000",
  config: { automation: "auto" },
  updatedAt: new Date(0),
} as unknown as RepurposeRun;

/** Ten words over ten seconds: "Log paise bachane ke 5 tarike nahi jaante Mumbai mein". */
const WORDS = [
  "Log",
  "paise",
  "bachane",
  "ke",
  "5",
  "tarike",
  "nahi",
  "jaante",
  "Mumbai",
  "mein",
].map((t, index) => ({
  wid: `0:${String(index)}` as WordId,
  t,
  s: index * 1_000,
  e: index * 1_000 + 800,
}));

const CHUNKS: TranscriptChunk[] = [{ chunkIdx: 0, startMs: 0, endMs: 30_000, words: WORDS }];

/** A clip project's editing document: two captions, no passes. */
function documentOf(projectId: string, aspect: "9:16" | "1:1" | "16:9"): EdgState {
  return fromProjection(
    {
      meta: { edgId: `${projectId.slice(0, 24)}ED`, projectId, revision: 1, schemaVersion: 2 },
      media: [{ mediaId: "01JFMED1A00000000000000000", role: "primary", durationMs: 30_000 }],
      transcript: {
        transcriptId: TRANSCRIPT,
        revision: 1,
        language: "hi-Latn",
        scripts: ["roman"],
      },
      canvas: {
        aspect,
        width: aspect === "16:9" ? 1920 : 1080,
        height: aspect === "9:16" ? 1920 : 1080,
      },
      styles: { defaultStyleId: "punch-pop" },
      segments: [
        {
          id: "01JFSEG1000000000000000000",
          seq: "V",
          startWordId: "0:0" as WordId,
          endWordId: "0:5" as WordId,
          startMs: 0,
          endMs: 5_800,
        },
        {
          id: "01JFSEG2000000000000000000",
          seq: "k",
          startWordId: "0:6" as WordId,
          endWordId: "0:9" as WordId,
          startMs: 6_000,
          endMs: 9_800,
        },
      ],
      passes: [],
    },
    { chunks: CHUNKS },
  );
}

interface Doc {
  state: EdgState;
  revision: number;
}

let docs: Map<string, Doc>;
let variants: Map<string, Record<string, unknown>>;
let jobs: Map<string, { status: string; finishedAt: Date | null }>;
let plan: { autocut: boolean; reframeZoom: boolean };
let applied: { projectId: string; ops: readonly EdgOp[] }[];
let passes: {
  startAutocut: ReturnType<typeof vi.fn>;
  startZoom: ReturnType<typeof vi.fn>;
};
let finishing: ClipFinishing;

function edgIdOf(projectId: string): string {
  return `${projectId.slice(0, 24)}ED`;
}

function docFor(projectId: string): Doc {
  const doc = docs.get(projectId);
  if (doc === undefined) throw new Error(`no document for ${projectId}`);
  return doc;
}

/** What `PassCompletionHandler` does when a pass lands: `MergePass` from the worker. */
function land(projectId: string, pass: Pass): void {
  const doc = docFor(projectId);
  const result = applyOps(doc.state, [{ opId: newId(), type: "MergePass", pass }], {
    source: "worker",
    revision: doc.revision + 1,
  });
  expect(result.rejected).toEqual([]);
  doc.state = result.state;
  doc.revision += 1;
}

function cutItem(itemId: string, startMs: number, endMs: number, extra: Partial<PassItem> = {}) {
  return {
    itemId,
    passId: CUT_PASS,
    kind: "cut" as const,
    startMs,
    endMs,
    payload: {},
    confidence: 0.9,
    reason: "silence",
    state: "proposed" as const,
    ...extra,
  } as PassItem;
}

function zoomItem(itemId: string, startMs: number, endMs: number): PassItem {
  return {
    itemId,
    passId: ZOOM_PASS,
    kind: "zoom",
    startMs,
    endMs,
    payload: {
      target: { x: 0.3, y: 0.2, w: 0.4, h: 0.4 },
      scaleFrom: 1,
      scaleTo: 1.15,
      easing: "easeInOut",
      keyframesRef: "ws/k.bin",
    },
    confidence: 0.8,
    state: "proposed",
  };
}

function cutPass(items: PassItem[]): Pass {
  return {
    passId: CUT_PASS,
    type: "autocut",
    engine: "autocut@standard",
    params: {},
    status: "ready",
    items,
  };
}

function zoomPass(items: PassItem[]): Pass {
  return {
    passId: ZOOM_PASS,
    type: "zoom",
    engine: "zoom@standard",
    params: {},
    status: "ready",
    items,
  };
}

function variant(
  id: string,
  projectId: string,
  aspect: FinishingVariant["aspect"],
): FinishingVariant {
  const row = variants.get(id);
  return {
    id,
    clipId: CLIP,
    projectId,
    aspect,
    finishing: (row?.["finishing"] ?? null) as FinishingVariant["finishing"],
  };
}

const vertical = (): FinishingVariant => variant(VERTICAL, PROJECT_9X16, "r9x16");

beforeEach(() => {
  docs = new Map([
    [PROJECT_9X16, { state: documentOf(PROJECT_9X16, "9:16"), revision: 1 }],
    [PROJECT_1X1, { state: documentOf(PROJECT_1X1, "1:1"), revision: 1 }],
    [PROJECT_16X9, { state: documentOf(PROJECT_16X9, "16:9"), revision: 1 }],
  ]);
  variants = new Map([
    [VERTICAL, { id: VERTICAL, projectId: PROJECT_9X16, finishing: null, latestExportId: null }],
    [SQUARE, { id: SQUARE, projectId: PROJECT_1X1, finishing: null, latestExportId: null }],
    [WIDE, { id: WIDE, projectId: PROJECT_16X9, finishing: null, latestExportId: null }],
  ]);
  jobs = new Map();
  plan = { autocut: true, reframeZoom: true };
  applied = [];
  passes = {
    startAutocut: vi.fn(async () => {
      jobs.set(CUT_JOB, { status: "queued", finishedAt: null });
      return { jobId: CUT_JOB, passId: CUT_PASS, status: "queued", deduplicated: false };
    }),
    startZoom: vi.fn(async () => {
      jobs.set(ZOOM_JOB, { status: "queued", finishedAt: null });
      return { jobId: ZOOM_JOB, passId: ZOOM_PASS, status: "queued", deduplicated: false };
    }),
  };

  const prisma = {
    edgDocument: {
      findUnique: vi.fn(async (args: { where: { projectId: string } }) => {
        const doc = docs.get(args.where.projectId);
        return doc === undefined
          ? null
          : { id: edgIdOf(args.where.projectId), revision: doc.revision };
      }),
    },
    clipVariant: {
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = variants.get(args.where.id);
        if (row === undefined) throw new Error("no such variant");
        return Object.assign(row, args.data);
      }),
      findUnique: vi.fn(
        async (args: { where: { clipId_aspect: { aspect: string } } }) =>
          (args.where.clipId_aspect.aspect === "r9x16" ? variants.get(VERTICAL) : undefined) ??
          null,
      ),
    },
    repurposeClip: {
      findUnique: vi.fn(async () => ({
        title: "Why most people never manage to save any money at all",
        copy: { hook: "Paise bachane ke 5 tarike" },
      })),
    },
    job: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => jobs.get(args.where.id) ?? null),
    },
    // `resolveStyleSnapshot`: no workspace presets, so the system catalogue answers.
    stylePreset: { findMany: vi.fn(async () => []) },
  };
  const edg = {
    applyWorkerOps: vi.fn(
      async (input: { projectId: string; ops: readonly EdgOp[]; baseRevision: number }) => {
        applied.push({ projectId: input.projectId, ops: input.ops });
        const doc = docFor(input.projectId);
        const result = applyOps(doc.state, input.ops, {
          source: "worker",
          revision: doc.revision + 1,
        });
        if (result.applied.length > result.skipped.length) {
          doc.state = result.state;
          doc.revision += 1;
        }
        return {
          revision: doc.revision,
          applied: result.applied,
          rebased: [],
          rejected: result.rejected,
        };
      },
    ),
  };
  const edgRepository = {
    projectionOf: vi.fn(async (edgId: string) => {
      for (const [projectId, doc] of docs) {
        if (edgIdOf(projectId) === edgId) return toProjection(doc.state);
      }
      throw new Error(`no document ${edgId}`);
    }),
    loadChunks: vi.fn(async () => CHUNKS),
  };
  const entitlements = {
    forWorkspace: vi.fn(async () => ({ entitlements: { passes: { ...plan } } })),
  };
  finishing = new ClipFinishing(
    prisma as never,
    edg as never,
    edgRepository as never,
    entitlements as never,
    passes as never,
  );
});

function projection(projectId: string) {
  return toProjection(docFor(projectId).state);
}

function recordOf(id: string) {
  return finishingRecordOf(variants.get(id)?.["finishing"]);
}

describe("ClipFinishing on a 9:16 shape", () => {
  it("cuts, emphasises, zooms and titles the clip, a step at a time, then lets the video be made", async () => {
    // 1. Autocut asked for; the video waits, and the clip reads "finishing".
    expect(await finishing.advance(RUN, vertical())).toBe("waiting");
    expect(passes.startAutocut).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_9X16, workspaceId: WS, preset: "standard" }),
    );
    expect(recordOf(VERTICAL)?.steps.autocut).toMatchObject({
      state: "requested",
      passId: CUT_PASS,
    });
    expect(finishingInProgress(variants.get(VERTICAL)?.["finishing"])).toBe(true);

    // Nothing moves while the pass runs.
    expect(await finishing.advance(RUN, vertical())).toBe("waiting");
    expect(applied).toEqual([]);

    // 2. The pass lands: the confident cuts are accepted, a shaky retake is left
    //    for a person; then the emphasis goes on, and the zoom pass is asked for.
    land(
      PROJECT_9X16,
      cutPass([
        cutItem("01JFCVT1000000000000000000", 300, 600),
        cutItem("01JFCVT2000000000000000000", 7_850, 8_000, { reason: "retake", confidence: 0.6 }),
        cutItem("01JFCVT3000000000000000000", 9_850, 9_990, { reason: "filler", confidence: 0.3 }),
      ]),
    );
    jobs.set(CUT_JOB, { status: "succeeded", finishedAt: new Date() });
    expect(await finishing.advance(RUN, vertical())).toBe("waiting");
    const items = projection(PROJECT_9X16).passes.flatMap((pass) => pass.items);
    expect(items.map((item) => [item.itemId, item.state])).toEqual([
      ["01JFCVT1000000000000000000", "accepted"],
      ["01JFCVT2000000000000000000", "proposed"],
      ["01JFCVT3000000000000000000", "proposed"],
    ]);
    // One keyword per caption: the number in the first, the name in the second.
    const segments = projection(PROJECT_9X16).segments;
    expect(segments.map((segment) => segment.emphasis)).toEqual([
      [{ wordId: "0:4", presetId: "pop" }],
      [{ wordId: "0:8", presetId: "pop" }],
    ]);
    expect(passes.startZoom).toHaveBeenCalledTimes(1);
    expect(recordOf(VERTICAL)?.steps).toMatchObject({
      autocut: { state: "done", applied: 1 },
      emphasis: { state: "done", applied: 2 },
      zoom: { state: "requested", passId: ZOOM_PASS },
    });

    // 3. The zoom pass lands: punch-ins after the hook title are taken, one
    //    under it is left. Then the hook title, and the edit is finished.
    land(
      PROJECT_9X16,
      zoomPass([
        zoomItem("01JFZ00M1000000000000000A0", 1_000, 2_000),
        zoomItem("01JFZ00M2000000000000000A0", 4_000, 5_000),
      ]),
    );
    jobs.set(ZOOM_JOB, { status: "succeeded", finishedAt: new Date() });
    expect(await finishing.advance(RUN, vertical())).toBe("just-finished");
    const zooms = projection(PROJECT_9X16)
      .passes.flatMap((pass) => pass.items)
      .filter((item) => item.kind === "zoom");
    expect(zooms.map((item) => item.state)).toEqual(["proposed", "accepted"]);
    // The hook covers the first 2.5 s of the video as cut: 300-600 ms is gone.
    expect(projection(PROJECT_9X16).overlays).toEqual([
      {
        id: VERTICAL,
        kind: "hook-title",
        text: "Paise bachane ke 5 tarike",
        startMs: 0,
        endMs: HOOK_TITLE_MS + 300,
      },
    ]);
    expect(recordOf(VERTICAL)).toMatchObject({ state: "done" });
    expect(finishingInProgress(variants.get(VERTICAL)?.["finishing"])).toBe(false);

    // 4. Finished for good: no more passes, no more writes.
    const before = applied.length;
    expect(await finishing.advance(RUN, vertical())).toBe("finished");
    expect(applied).toHaveLength(before);
    expect(passes.startAutocut).toHaveBeenCalledTimes(1);
  });

  it("skips what the plan does not include, and still emphasises and titles the clip", async () => {
    plan = { autocut: false, reframeZoom: false };
    expect(await finishing.advance(RUN, vertical())).toBe("just-finished");
    expect(passes.startAutocut).not.toHaveBeenCalled();
    expect(passes.startZoom).not.toHaveBeenCalled();
    expect(recordOf(VERTICAL)?.steps).toMatchObject({
      autocut: { state: "skipped", reason: "plan" },
      emphasis: { state: "done", applied: 2 },
      zoom: { state: "skipped", reason: "plan" },
      hook: { state: "done", applied: 1 },
    });
    expect(projection(PROJECT_9X16).overlays?.[0]).toMatchObject({
      startMs: 0,
      endMs: HOOK_TITLE_MS,
    });
  });

  it("skips a pass the credits cannot pay for, never failing the clip", async () => {
    passes.startAutocut.mockRejectedValueOnce(
      new AppException("credits/insufficient", "Not enough credits for this job.", 402),
    );
    plan.reframeZoom = false;
    expect(await finishing.advance(RUN, vertical())).toBe("just-finished");
    expect(recordOf(VERTICAL)?.steps.autocut).toMatchObject({
      state: "skipped",
      reason: "credits",
    });
  });

  it("waits, recording nothing it has not done, while the plan's lane is full", async () => {
    passes.startAutocut.mockRejectedValueOnce(
      new AppException(JOB_ERROR_CODES.concurrencyCap, "lane full", 429),
    );
    expect(await finishing.advance(RUN, vertical())).toBe("waiting");
    expect(recordOf(VERTICAL)).toMatchObject({ state: "running", steps: {} });
    expect(await finishing.advance(RUN, vertical())).toBe("waiting");
    expect(recordOf(VERTICAL)?.steps.autocut).toMatchObject({ state: "requested" });
  });

  it("moves on when a pass fails, or never lands", async () => {
    expect(await finishing.advance(RUN, vertical())).toBe("waiting");
    jobs.set(CUT_JOB, { status: "failed", finishedAt: new Date() });
    plan.reframeZoom = false;
    expect(await finishing.advance(RUN, vertical())).toBe("just-finished");
    expect(recordOf(VERTICAL)?.steps.autocut).toMatchObject({ state: "skipped", reason: "failed" });
  });

  it("gives up waiting after the whole pass has run too long, and still titles the clip", async () => {
    expect(await finishing.advance(RUN, vertical())).toBe("waiting");
    const later = new Date(Date.now() + FINISHING_MAX_MS + 1_000);
    expect(await finishing.advance(RUN, vertical(), later)).toBe("just-finished");
    // The pass that never landed is let go and no new one is paid for; the
    // steps that never wait still run.
    expect(passes.startZoom).not.toHaveBeenCalled();
    expect(recordOf(VERTICAL)?.steps).toMatchObject({
      autocut: { state: "skipped", reason: "timeout" },
      emphasis: { state: "done", applied: 2 },
      zoom: { state: "skipped", reason: "timeout" },
      hook: { state: "done", applied: 1 },
    });
  });

  it("keeps a hook title and emphasis a person already set", async () => {
    plan = { autocut: false, reframeZoom: false };
    const doc = docFor(PROJECT_9X16);
    const mine = applyOps(
      doc.state,
      [
        {
          opId: "01JFMY0VERLAY0000000000000",
          type: "SetOverlay",
          overlay: {
            id: "01JFMYH00K0000000000000000",
            kind: "hook-title",
            text: "Mine",
            startMs: 0,
            endMs: 2_000,
          },
        },
        {
          opId: "01JFMYEMPH0000000000000000",
          type: "SetEmphasis",
          segmentId: "01JFSEG1000000000000000000",
          wordId: "0:1" as WordId,
          presetId: "shout",
        },
      ],
      { source: "worker", revision: 2 },
    );
    doc.state = mine.state;
    doc.revision = 2;
    expect(await finishing.advance(RUN, vertical())).toBe("just-finished");
    const after = projection(PROJECT_9X16);
    expect(
      after.overlays?.map((overlay) =>
        overlay.kind === "hook-title" ? overlay.text : overlay.kind,
      ),
    ).toEqual(["Mine"]);
    expect(after.segments[0]?.emphasis).toEqual([{ wordId: "0:1", presetId: "shout" }]);
    expect(after.segments[1]?.emphasis).toEqual([{ wordId: "0:8", presetId: "pop" }]);
  });
});

describe("ClipFinishing on the other shapes", () => {
  async function finishVertical(): Promise<void> {
    await finishing.advance(RUN, vertical());
    land(PROJECT_9X16, cutPass([cutItem("01JFCVT1000000000000000000", 300, 600)]));
    jobs.set(CUT_JOB, { status: "succeeded", finishedAt: new Date() });
    plan.reframeZoom = false;
    expect(await finishing.advance(RUN, vertical())).toBe("just-finished");
    plan.reframeZoom = true;
  }

  it("takes the 9:16 shape's cuts instead of paying for a pass of its own", async () => {
    await finishVertical();
    passes.startAutocut.mockClear();
    const square = variant(SQUARE, PROJECT_1X1, "r1x1");
    expect(await finishing.advance(RUN, square)).toBe("waiting"); // its zoom pass runs
    expect(passes.startAutocut).not.toHaveBeenCalled();
    const cuts = projection(PROJECT_1X1)
      .passes.flatMap((pass) => pass.items)
      .filter((item) => item.kind === "cut");
    expect(cuts).toMatchObject([{ startMs: 300, endMs: 600, state: "accepted" }]);
    expect(recordOf(SQUARE)?.steps.autocut).toMatchObject({
      state: "done",
      applied: 1,
      copiedFrom: VERTICAL,
    });
  });

  it("waits for the 9:16 shape's cuts while they are being made", async () => {
    await finishing.advance(RUN, vertical());
    const square = variant(SQUARE, PROJECT_1X1, "r1x1");
    expect(await finishing.advance(RUN, square)).toBe("waiting");
    expect(recordOf(SQUARE)?.steps.autocut).toBeUndefined();
  });

  it("never zooms a 16:9 shape", async () => {
    await finishVertical();
    passes.startZoom.mockClear();
    const wide = variant(WIDE, PROJECT_16X9, "r16x9");
    expect(await finishing.advance(RUN, wide)).toBe("just-finished");
    expect(passes.startZoom).not.toHaveBeenCalled();
    expect(recordOf(WIDE)?.steps.zoom).toMatchObject({ state: "skipped", reason: "shape" });
    expect(projection(PROJECT_16X9).overlays).toHaveLength(1);
  });
});

describe("ClipFinishing, two-speaker layouts (2026-10-01)", () => {
  const ZOOM_1 = "01JFZ00M1000000000000000AA";
  const ZOOM_2 = "01JFZ00M2000000000000000AA";

  it("never zooms a shape with both speakers stacked", async () => {
    plan.autocut = false;
    const stacked: FinishingVariant = { ...vertical(), layout: "stacked" };
    expect(await finishing.advance(RUN, stacked)).toBe("just-finished");
    expect(passes.startZoom).not.toHaveBeenCalled();
    expect(recordOf(VERTICAL)?.steps.zoom).toMatchObject({ state: "skipped", reason: "layout" });
    // Everything else is finished as on any clip.
    expect(projection(PROJECT_9X16).overlays).toHaveLength(1);
  });

  it("accepts no zoom from a pass that lands after the clip was cut again stacked", async () => {
    plan.autocut = false;
    // Emphasised, and its zoom pass asked for, on the one-window picture.
    expect(await finishing.advance(RUN, vertical())).toBe("waiting");
    expect(passes.startZoom).toHaveBeenCalledTimes(1);
    land(PROJECT_9X16, zoomPass([zoomItem(ZOOM_1, 3_000, 4_000)]));
    jobs.set(ZOOM_JOB, { status: "succeeded", finishedAt: new Date() });

    const stacked: FinishingVariant = { ...vertical(), layout: "stacked" };
    expect(await finishing.advance(RUN, stacked)).toBe("just-finished");
    const items = projection(PROJECT_9X16).passes.flatMap((pass) => pass.items);
    expect(items.find((item) => item.itemId === ZOOM_1)?.state).toBe("proposed");
    expect(recordOf(VERTICAL)?.steps.zoom).toMatchObject({ state: "done", applied: 0 });
  });

  it("turns down the zooms accepted for a one-window picture, and leaves proposals", async () => {
    land(PROJECT_9X16, zoomPass([zoomItem(ZOOM_1, 3_000, 4_000), zoomItem(ZOOM_2, 6_000, 7_000)]));
    const doc = docFor(PROJECT_9X16);
    const accepted = applyOps(
      doc.state,
      [{ opId: newId(), type: "DecideItems", itemIds: [ZOOM_1], state: "accepted" }],
      { source: "worker", revision: doc.revision + 1 },
    );
    doc.state = accepted.state;
    doc.revision += 1;

    expect(await finishing.dropZooms(PROJECT_9X16)).toBe(1);
    const items = projection(PROJECT_9X16).passes.flatMap((pass) => pass.items);
    expect(items.find((item) => item.itemId === ZOOM_1)?.state).toBe("rejected");
    expect(items.find((item) => item.itemId === ZOOM_2)?.state).toBe("proposed");
    // Nothing more to turn down, and a project with no document has none.
    expect(await finishing.dropZooms(PROJECT_9X16)).toBe(0);
    expect(await finishing.dropZooms("01JFN0D0C000000000000000AA")).toBe(0);
  });
});

describe("hookTextOf", () => {
  it("prefers the clip's own hook, and falls back to its title cut to seven words", () => {
    expect(hookTextOf({ hook: "  Ye galti mat karna  " }, "Title")).toBe("Ye galti mat karna");
    expect(hookTextOf({}, "Why most people never manage to save any money at all")).toBe(
      "Why most people never manage to save",
    );
    expect(hookTextOf({ hook: "" }, "Short title")).toBe("Short title");
    expect(hookTextOf({ hook: "Paise bachao." }, "x")).toBe("Paise bachao");
    expect(hookTextOf({ hook: "Kya aap ye galti karte ho?" }, "x")).toBe(
      "Kya aap ye galti karte ho?",
    );
  });

  it("does not end on a dangling word or comma where it was cut", () => {
    expect(hookTextOf({}, "Paise bachane ka sabse aasaan tarika aur uske fayde")).toBe(
      "Paise bachane ka sabse aasaan tarika",
    );
    expect(hookTextOf({}, "First, second, third, fourth, fifth, sixth, seventh, eighth")).toBe(
      "First, second, third, fourth, fifth, sixth, seventh",
    );
  });

  it("has nothing for a moment a person marked without naming it", () => {
    expect(hookTextOf({}, "Moment at 1:23–1:45")).toBe("");
    expect(hookTextOf({ hook: "Named after all" }, "Moment at 1:23–1:45")).toBe("Named after all");
  });
});

describe("hookWindow", () => {
  it("covers the first 2.5 seconds as the viewer sees them, after the cuts", () => {
    expect(hookWindow([], 30_000)).toEqual({ startMs: 0, endMs: HOOK_TITLE_MS });
    const cutAtStart = {
      ...cutItem("01JFCVT1000000000000000000", 0, 400),
      state: "accepted",
    } as PassItem;
    expect(hookWindow([cutAtStart], 30_000)).toEqual({ startMs: 400, endMs: 400 + HOOK_TITLE_MS });
  });

  it("fits a clip shorter than the hook, and has none for an empty one", () => {
    expect(hookWindow([], 1_800)).toEqual({ startMs: 0, endMs: 1_800 });
    expect(hookWindow([], 0)).toBeUndefined();
  });
});

describe("acceptableCut", () => {
  it("takes confident silences, pauses and fillers, and only very sure retakes", () => {
    expect(acceptableCut(cutItem("01JFCVT1000000000000000000", 0, 1))).toBe(true);
    expect(acceptableCut(cutItem("01JFCVT1000000000000000000", 0, 1, { confidence: 0.4 }))).toBe(
      false,
    );
    expect(
      acceptableCut(
        cutItem("01JFCVT1000000000000000000", 0, 1, { reason: "retake", confidence: 0.7 }),
      ),
    ).toBe(false);
    expect(
      acceptableCut(
        cutItem("01JFCVT1000000000000000000", 0, 1, { reason: "retake", confidence: 0.8 }),
      ),
    ).toBe(true);
    expect(acceptableCut(cutItem("01JFCVT1000000000000000000", 0, 1, { state: "rejected" }))).toBe(
      false,
    );
  });
});

describe("keywordPresetId", () => {
  it("takes the style's first preset that reads on every caption", () => {
    expect(
      keywordPresetId([
        { id: "pop", effect: "none" },
        { id: "shout", effect: "shake" },
      ]),
    ).toBe("pop");
    expect(keywordPresetId([{ id: "accent" }])).toBe("accent");
  });

  it("passes over a marker that would hide the word, and a jolt on every line", () => {
    expect(
      keywordPresetId([
        { id: "mark", effect: "highlight" },
        { id: "shout", effect: "shake" },
        { id: "underline", effect: "underline" },
      ]),
    ).toBe("underline");
    expect(keywordPresetId([{ id: "mark", effect: "highlight" }])).toBeUndefined();
    expect(keywordPresetId(undefined)).toBeUndefined();
  });
});
