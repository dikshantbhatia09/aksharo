import { describe, expect, it, vi } from "vitest";

import type { EdgHot, EdgOp, Segment, TranscriptChunk } from "@montaj/edg";

import {
  LocalResegmentUnsupportedError,
  createLocalEditorStoreDeps,
  loadLocalEditorInit,
} from "./store.js";

import type { EditorStoreInit } from "./store.js";

/**
 * `apps/web/lib/edg/store.ts`'s local branch (brief C04/C04b §2): `EditorStore`
 * run against the desktop's local IPC instead of the API. A fake
 * `window.aksharoDesktop.local` is enough to prove the deps — no Electron
 * runtime, no real SQLite, exactly `apps/desktop/src/local/store.test.ts`'s
 * pattern on the other side of the same seam.
 */
function fixtureHot(): EdgHot {
  return {
    meta: { edgId: "e1", projectId: "p1", revision: 1, schemaVersion: 2 },
    media: [],
    transcript: { transcriptId: "t1", revision: 1, language: "hi-Latn", scripts: ["roman"] },
    canvas: { aspect: "9:16", width: 1080, height: 1920 },
    styles: { defaultStyleId: "clean-bold" },
  };
}

function fixtureSegments(): Segment[] {
  return [
    {
      id: "s1",
      seq: "V",
      startWordId: "0:0" as never,
      endWordId: "0:0" as never,
      startMs: 0,
      endMs: 400,
    },
  ];
}

/** One chunk carrying the single word `fixtureSegments()` addresses. */
function fixtureChunks(): TranscriptChunk[] {
  return [
    { chunkIdx: 0, startMs: 0, endMs: 400, words: [{ wid: "0:0", s: 0, e: 400, t: "Bhai" }] },
  ];
}

interface FakeSnapshot {
  hot: EdgHot;
  segments: Segment[];
  chunks: TranscriptChunk[];
  revision: number;
}

function fakeLocalApi(initial: {
  hot: EdgHot;
  segments: Segment[];
  chunks?: TranscriptChunk[];
  revision: number;
}) {
  let snapshot: FakeSnapshot | null = { ...initial, chunks: initial.chunks ?? [] };
  const saveEdgSnapshot = vi.fn(
    async (input: { projectId: string; hot: unknown; segments: unknown[]; chunks?: unknown[] }) => {
      snapshot = {
        hot: input.hot as EdgHot,
        segments: input.segments as Segment[],
        chunks: (input.chunks as TranscriptChunk[] | undefined) ?? snapshot?.chunks ?? [],
        revision: (snapshot?.revision ?? 0) + 1,
      };
      return {
        id: "snap-1",
        projectId: input.projectId,
        revision: snapshot.revision,
        hot: snapshot.hot,
        segments: snapshot.segments,
        chunks: snapshot.chunks,
        createdAt: new Date().toISOString(),
      };
    },
  );
  const latestSnapshot = vi.fn(async () =>
    snapshot === null
      ? null
      : {
          id: "snap-1",
          projectId: "p1",
          revision: snapshot.revision,
          hot: snapshot.hot,
          segments: snapshot.segments,
          chunks: snapshot.chunks,
          createdAt: new Date().toISOString(),
        },
  );
  return { saveEdgSnapshot, latestSnapshot, getSnapshot: () => snapshot };
}

describe("loadLocalEditorInit", () => {
  it("builds EditorStoreInit from the latest local snapshot", async () => {
    const api = fakeLocalApi({ hot: fixtureHot(), segments: fixtureSegments(), revision: 3 });
    const init = await loadLocalEditorInit(api as never, "p1");
    expect(init.revision).toBe(3);
    expect(init.segments).toEqual(fixtureSegments());
    expect(init.chunks).toEqual([]);
    expect(init.passes).toEqual([]);
  });

  it("carries the project's transcript chunks into EditorStoreInit", async () => {
    const api = fakeLocalApi({
      hot: fixtureHot(),
      segments: fixtureSegments(),
      chunks: fixtureChunks(),
      revision: 1,
    });
    const init = await loadLocalEditorInit(api as never, "p1");
    expect(init.chunks).toEqual(fixtureChunks());
  });

  it("throws when the project has never been saved", async () => {
    const api = fakeLocalApi({ hot: fixtureHot(), segments: fixtureSegments(), revision: 1 });
    (api.latestSnapshot as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(loadLocalEditorInit(api as never, "p1")).rejects.toThrow(/no saved EDG snapshot/);
  });
});

describe("createLocalEditorStoreDeps", () => {
  function setup(chunks: TranscriptChunk[] = []) {
    const hot = fixtureHot();
    const segments = fixtureSegments();
    const api = fakeLocalApi({ hot, segments, chunks, revision: 1 });
    const init: EditorStoreInit = { hot, segments, passes: [], chunks, revision: 1 };
    const deps = createLocalEditorStoreDeps({ local: api as never, projectId: "p1", init });
    return { api, deps, init };
  }

  it("applies a segment-level op and persists a new snapshot via the local IPC", async () => {
    const { api, deps } = setup();
    const op: EdgOp = { opId: "op1", type: "HideSegment", segmentId: "s1", hidden: true };

    const result = await deps.applyBatch({ baseRevision: 1, ops: [op], clientOpIds: [op.opId] });

    expect(result.revision).toBe(2);
    expect(result.applied).toEqual([op.opId]);
    expect(result.rebased).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(api.saveEdgSnapshot).toHaveBeenCalledTimes(1);
    const saved = api.getSnapshot();
    expect((saved?.segments[0] as { hidden?: boolean }).hidden).toBe(true);
    // A pure segment-level edit never touched a word, so it never sends chunks.
    expect(api.saveEdgSnapshot.mock.calls[0]?.[0]).not.toHaveProperty("chunks");
  });

  it("never calls saveEdgSnapshot when nothing actually changed (a pure replay)", async () => {
    const { api, deps } = setup();
    const op: EdgOp = { opId: "op1", type: "HideSegment", segmentId: "s1", hidden: true };
    await deps.applyBatch({ baseRevision: 1, ops: [op], clientOpIds: [op.opId] });
    api.saveEdgSnapshot.mockClear();

    // The same opId again: `applyOps`'s idempotency window reports it as
    // applied-but-skipped, so this must not persist a second time.
    const replay = await deps.applyBatch({ baseRevision: 2, ops: [op], clientOpIds: [op.opId] });

    expect(replay.applied).toEqual([op.opId]);
    expect(api.saveEdgSnapshot).not.toHaveBeenCalled();
  });

  it("reports a rejected op without throwing, and does not bump the revision", async () => {
    const { deps } = setup();
    const badOp: EdgOp = {
      opId: "op1",
      type: "HideSegment",
      segmentId: "no-such-segment",
      hidden: true,
    };

    const result = await deps.applyBatch({
      baseRevision: 1,
      ops: [badOp],
      clientOpIds: [badOp.opId],
    });

    expect(result.applied).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.revision).toBe(1);
  });

  it("rejects a word-addressed op with unknown-id when no transcript chunks are stored", async () => {
    const { deps } = setup();
    const op: EdgOp = { opId: "op1", type: "EditWord", wordId: "0:0", text: "hi", script: "roman" };

    const result = await deps.applyBatch({ baseRevision: 1, ops: [op], clientOpIds: [op.opId] });

    expect(result.rejected[0]?.reason).toBe("unknown-id");
  });

  it("brief C04b §1: applies a word-addressed op once chunks are stored, and persists the patched chunk", async () => {
    const { api, deps } = setup(fixtureChunks());
    const op: EdgOp = { opId: "op1", type: "EditWord", wordId: "0:0", text: "Namaste" };

    const result = await deps.applyBatch({ baseRevision: 1, ops: [op], clientOpIds: [op.opId] });

    expect(result.applied).toEqual([op.opId]);
    expect(result.rejected).toEqual([]);
    const saved = api.getSnapshot();
    expect(saved?.chunks[0]?.words[0]?.t).toBe("Namaste");
    // A word op did touch the transcript, so this time chunks are sent.
    expect(api.saveEdgSnapshot.mock.calls[0]?.[0]).toHaveProperty("chunks");
  });

  it("brief C04b §1: DeleteWord, SetWordTiming and InsertWordAfter all round-trip locally", async () => {
    const { deps } = setup(fixtureChunks());

    const timing = await deps.applyBatch({
      baseRevision: 1,
      ops: [{ opId: "op1", type: "SetWordTiming", wordId: "0:0", s: 10, e: 390 }],
      clientOpIds: ["op1"],
    });
    expect(timing.applied).toEqual(["op1"]);

    const inserted = await deps.applyBatch({
      baseRevision: timing.revision,
      ops: [
        {
          opId: "op2",
          type: "InsertWordAfter",
          wordId: "0:0",
          newWordId: "0:1",
          text: "bhai",
          s: 390,
          e: 400,
        },
      ],
      clientOpIds: ["op2"],
    });
    expect(inserted.applied).toEqual(["op2"]);

    const deleted = await deps.applyBatch({
      baseRevision: inserted.revision,
      ops: [{ opId: "op3", type: "DeleteWord", wordId: "0:1" }],
      clientOpIds: ["op3"],
    });
    expect(deleted.applied).toEqual(["op3"]);
  });

  it("rejects resegment as unsupported when the project has no transcript chunks", async () => {
    const { deps } = setup();
    await expect(
      deps.resegment({ maxChars: 18, maxLines: 1, minMs: 400, maxMs: 3_000 }),
    ).rejects.toThrow(LocalResegmentUnsupportedError);
  });

  it("brief C04b §1: resegment runs locally once transcript chunks are stored", async () => {
    const { api, deps } = setup(fixtureChunks());

    const result = await deps.resegment({ maxChars: 18, maxLines: 1, minMs: 100, maxMs: 3_000 });

    expect(result.applied).toHaveLength(1);
    expect(result.rejected).toEqual([]);
    expect(api.saveEdgSnapshot).toHaveBeenCalledTimes(1);
  });

  it("reloadDocument re-reads the latest snapshot", async () => {
    const { api, deps } = setup();
    const op: EdgOp = { opId: "op1", type: "HideSegment", segmentId: "s1", hidden: true };
    await deps.applyBatch({ baseRevision: 1, ops: [op], clientOpIds: [op.opId] });

    const reloaded = await deps.reloadDocument();

    expect(reloaded.revision).toBe(2);
    expect((reloaded.segments[0] as { hidden?: boolean }).hidden).toBe(true);
    expect(api.latestSnapshot).toHaveBeenCalled();
  });
});
