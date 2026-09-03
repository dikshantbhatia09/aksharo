import { describe, expect, it } from "vitest";

import { applyOps, fromProjection, newId, rebaseOps, toProjection } from "@montaj/edg";
import type { EdgOp, EdgState, EdgHot, Pass, Segment, TranscriptChunk, Word } from "@montaj/edg";

import { EdgConflictError, EdgTooStaleError } from "./queue";
import { EditorStore, type EditorStoreDeps, type EditorStoreInit } from "./store";

import type { OpBatchResponse } from "./client";

/**
 * A small fixture: two segments, four words, two speakers — enough surface
 * for every op the store emits without a real transcript.
 */
function fixtureInit(): EditorStoreInit {
  const hot: EdgHot = {
    meta: { edgId: "e1", projectId: "p1", revision: 1, schemaVersion: 2 },
    media: [{ mediaId: "m1", role: "primary", durationMs: 4000 }],
    transcript: { transcriptId: "t1", revision: 1, language: "en", scripts: ["roman"] },
    canvas: { aspect: "9:16", width: 1080, height: 1920 },
    styles: { defaultStyleId: "punch-pop" },
  };
  const chunks: TranscriptChunk[] = [
    {
      chunkIdx: 0,
      startMs: 0,
      endMs: 4000,
      words: [
        { wid: "0:0", s: 0, e: 500, t: "hello", sp: "sp1" },
        { wid: "0:1", s: 500, e: 1000, t: "there", sp: "sp1" },
        { wid: "0:2", s: 2000, e: 2500, t: "world", sp: "sp2" },
        { wid: "0:3", s: 2500, e: 3000, t: "today", sp: "sp2" },
      ],
    },
  ];
  const segments: Segment[] = [
    {
      id: "s1",
      seq: "V",
      startWordId: "0:0" as never,
      endWordId: "0:1" as never,
      startMs: 0,
      endMs: 1000,
    },
    {
      id: "s2",
      seq: "W",
      startWordId: "0:2" as never,
      endWordId: "0:3" as never,
      startMs: 2000,
      endMs: 3000,
    },
  ];
  const passes: Pass[] = [];
  return { hot, segments, passes, chunks, revision: 1 };
}

/**
 * A minimal in-memory stand-in for A12's write path: the same
 * `@montaj/edg/ops` `applyOps`/`rebaseOps` this app's queue and the real API
 * both call, over one shared `EdgState`, with the same 409 split (rebase vs.
 * conflict) `apps/api/src/edg/edg.repository.ts` implements. It exists so
 * this suite can prove the *store's* reaction to a real conflict without
 * booting the API — the engine itself is `packages/edg`'s to test.
 */
class FakeEdgServer {
  private state: EdgState;
  private revision: number;
  private readonly log: { revision: number; ops: EdgOp[] }[] = [];

  constructor(init: EditorStoreInit) {
    this.state = fromProjection(
      { ...init.hot, segments: init.segments, passes: init.passes },
      { chunks: init.chunks },
    );
    this.revision = init.revision;
  }

  currentRevision(): number {
    return this.revision;
  }

  projection() {
    return toProjection(this.state);
  }

  /** `toProjection` (the EDG document projection) carries no words — they live
   * in their own table — so this reads them from the state directly. */
  words(): Word[] {
    return [...this.state.words.values()];
  }

  applyBatch(body: { baseRevision: number; ops: EdgOp[]; clientOpIds: string[] }): OpBatchResponse {
    let ops = body.ops;
    if (body.baseRevision < this.revision) {
      const opsSince = this.log
        .filter((entry) => entry.revision > body.baseRevision)
        .flatMap((entry) => entry.ops);
      const { rebased, rejected } = rebaseOps(ops, opsSince);
      const conflicts = rejected.filter((entry) => entry.reason === "conflict");
      if (conflicts.length > 0) {
        throw new EdgConflictError({
          latestRevision: this.revision,
          opsSince,
          conflicts: conflicts.map((entry) => {
            const mine = ops.find((op) => op.opId === entry.opId);
            const winner = [...opsSince].reverse().find((op) => op.opId !== entry.opId);
            return {
              opId: entry.opId,
              target: mine?.type === "EditWord" ? ("word" as const) : ("segment" as const),
              targetId:
                mine?.type === "EditWord"
                  ? mine.wordId
                  : mine?.type === "SetSegmentText"
                    ? mine.segmentId
                    : "",
              yours: mine?.type === "EditWord" || mine?.type === "SetSegmentText" ? mine.text : "",
              theirs:
                winner?.type === "EditWord" || winner?.type === "SetSegmentText" ? winner.text : "",
            };
          }),
        });
      }
      ops = rebased;
    }
    const nextRevision = this.revision + 1;
    const result = applyOps(this.state, ops, { source: "web", revision: nextRevision });
    if (result.applied.length > result.skipped.length) {
      this.state = result.state;
      this.revision = nextRevision;
      this.log.push({ revision: this.revision, ops });
    }
    return {
      revision: this.revision,
      applied: result.applied.filter((opId) => !result.rejected.some((r) => r.opId === opId)),
      rebased:
        ops !== body.ops
          ? ops.map((op) => op.opId).filter((opId) => result.applied.includes(opId))
          : [],
      rejected: result.rejected,
    };
  }
}

function depsFor(server: FakeEdgServer, overrides: Partial<EditorStoreDeps> = {}): EditorStoreDeps {
  return {
    applyBatch: (body) => Promise.resolve(server.applyBatch(body)),
    resegment: () => Promise.reject(new Error("not exercised in this suite")),
    reloadDocument: () =>
      Promise.resolve({
        hot: server.projection() as never,
        segments: server.projection().segments,
        passes: server.projection().passes,
        revision: server.currentRevision(),
      }),
    ...overrides,
  };
}

describe("EditorStore", () => {
  it("applies an op optimistically before the network call resolves", async () => {
    const init = fixtureInit();
    let resolveNetwork: (() => void) | undefined;
    const applyBatch = (): Promise<OpBatchResponse> =>
      new Promise((resolve) => {
        resolveNetwork = () => resolve({ revision: 2, applied: ["a"], rebased: [], rejected: [] });
      });
    const store = new EditorStore(init, {
      applyBatch: async (body) => {
        void body;
        return applyBatch();
      },
      resegment: () => Promise.reject(new Error("n/a")),
      reloadDocument: () => Promise.reject(new Error("n/a")),
      newId: () => "a",
    });

    store.submitOp({ type: "EditWord", opId: "a", wordId: "0:0" as never, text: "hi" });
    expect(store.getSnapshot().state.words.get("0:0" as never)?.t).toBe("hi");
    expect(store.getSnapshot().pendingCount).toBe(1);

    resolveNetwork?.();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("two sessions editing the same word produce the conflict chooser", async () => {
    const init = fixtureInit();
    const server = new FakeEdgServer(init);
    const alice = new EditorStore(init, depsFor(server, { newId: () => "alice-op" }));
    const bob = new EditorStore(init, depsFor(server, { newId: () => "bob-op" }));

    alice.submitOp({ type: "EditWord", opId: "alice-op", wordId: "0:0" as never, text: "hola" });
    await alice.flush();
    expect(server.currentRevision()).toBe(2);

    // Bob is still at revision 1 when he submits — the server rebases his
    // batch against Alice's edit and finds a same-word conflict (rebase table
    // rule 3), which the queue turns into `EditorStore`'s `conflicts`.
    bob.submitOp({ type: "EditWord", opId: "bob-op", wordId: "0:0" as never, text: "bonjour" });
    await bob.flush();

    const snapshot = bob.getSnapshot();
    expect(snapshot.conflicts).toHaveLength(1);
    expect(snapshot.conflicts[0]).toMatchObject({
      target: "word",
      targetId: "0:0",
      yours: "bonjour",
      theirs: "hola",
    });
  });

  it("edits to different segments merge cleanly with no conflict", async () => {
    const init = fixtureInit();
    const server = new FakeEdgServer(init);
    const alice = new EditorStore(init, depsFor(server, { newId: () => "alice-op" }));
    const bob = new EditorStore(init, depsFor(server, { newId: () => "bob-op" }));

    alice.submitOp({ type: "EditWord", opId: "alice-op", wordId: "0:0" as never, text: "hola" });
    await alice.flush();

    bob.submitOp({ type: "EditWord", opId: "bob-op", wordId: "0:2" as never, text: "monde" });
    await bob.flush();

    expect(bob.getSnapshot().conflicts).toHaveLength(0);
    expect(server.words().find((w) => w.wid === "0:0")?.t).toBe("hola");
    expect(server.words().find((w) => w.wid === "0:2")?.t).toBe("monde");
  });

  it("resolveConflict('mine') submits the local text as a fresh op and clears the conflict", async () => {
    const init = fixtureInit();
    const server = new FakeEdgServer(init);
    const alice = new EditorStore(init, depsFor(server, { newId: () => "alice-op" }));
    const bob = new EditorStore(init, depsFor(server, { newId: () => "bob-op" }));

    alice.submitOp({ type: "EditWord", opId: "alice-op", wordId: "0:0" as never, text: "hola" });
    await alice.flush();
    bob.submitOp({ type: "EditWord", opId: "bob-op", wordId: "0:0" as never, text: "bonjour" });
    await bob.flush();

    const conflict = bob.getSnapshot().conflicts[0];
    expect(conflict).toBeDefined();
    bob.resolveConflict(conflict!.opId, "mine");
    expect(bob.getSnapshot().conflicts).toHaveLength(0);
    expect(bob.getSnapshot().state.words.get("0:0" as never)?.t).toBe("bonjour");

    await bob.flush();
    expect(server.words().find((w) => w.wid === "0:0")?.t).toBe("bonjour");
  });

  it("edg/too_stale surfaces on the snapshot and reload() recovers it", async () => {
    const init = fixtureInit();
    let calls = 0;
    const store = new EditorStore(init, {
      applyBatch: () => {
        calls += 1;
        return Promise.reject(new EdgTooStaleError(999));
      },
      resegment: () => Promise.reject(new Error("n/a")),
      reloadDocument: () =>
        Promise.resolve({
          hot: init.hot,
          segments: init.segments,
          passes: init.passes,
          revision: 999,
        }),
    });

    store.submitOp({ type: "EditWord", opId: newId(), wordId: "0:0" as never, text: "hi" });
    await store.flush();
    expect(store.getSnapshot().tooStale).toBe(true);
    expect(calls).toBe(1);

    await store.reload();
    expect(store.getSnapshot().tooStale).toBe(false);
    expect(store.getSnapshot().canUndo).toBe(false);
  });

  it("absorbRemoteOps merges a realtime edg.ops event into local state", () => {
    const init = fixtureInit();
    const store = new EditorStore(init, {
      applyBatch: () => Promise.reject(new Error("n/a")),
      resegment: () => Promise.reject(new Error("n/a")),
      reloadDocument: () => Promise.reject(new Error("n/a")),
    });
    store.absorbRemoteOps(
      [{ type: "EditWord", opId: "remote-1", wordId: "0:0" as never, text: "salut" }],
      2,
    );
    expect(store.getSnapshot().state.words.get("0:0" as never)?.t).toBe("salut");
    expect(store.getSnapshot().serverRevision).toBe(2);
  });

  it("a realtime echo of this session's own pending op is a safe no-op, not a conflict (M14)", async () => {
    // The exact bug M10's gate-a repro found: right after this store submits
    // an op, the server broadcasts it to every room member including the
    // sender, and that broadcast typically beats the HTTP response back —
    // `absorbRemoteOps` must recognize its own opId and not rebase the still-
    // pending op against an "incoming" copy of itself.
    const init = fixtureInit();
    let resolveNetwork: ((response: OpBatchResponse) => void) | undefined;
    const store = new EditorStore(init, {
      applyBatch: () =>
        new Promise((resolve) => {
          resolveNetwork = resolve;
        }),
      resegment: () => Promise.reject(new Error("n/a")),
      reloadDocument: () => Promise.reject(new Error("n/a")),
      newId: () => "mine",
      // Fire the debounce immediately (synchronously) so `flush()` — and so
      // `applyBatch` — has actually started by the time this test inspects
      // `pendingCount`, instead of waiting on a real 250ms timer.
      setTimeoutFn: (handler) => {
        handler();
        return 0;
      },
      clearTimeoutFn: () => undefined,
    });

    const op: EdgOp = { type: "EditWord", opId: "mine", wordId: "0:0" as never, text: "hola" };
    store.submitOp(op);
    expect(store.getSnapshot().pendingCount).toBe(1);

    // The echo of `op` — same opId — arrives over the socket before the HTTP
    // response does.
    store.absorbRemoteOps([op], 2);

    expect(store.getSnapshot().conflicts).toHaveLength(0);
    expect(store.getSnapshot().state.words.get("0:0" as never)?.t).toBe("hola");
    // Still pending — only the real batch response resolves it.
    expect(store.getSnapshot().pendingCount).toBe(1);

    resolveNetwork?.({ revision: 2, applied: ["mine"], rebased: [], rejected: [] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().conflicts).toHaveLength(0);
    expect(store.getSnapshot().pendingCount).toBe(0);
  });

  it("a genuinely remote edit on the same word still raises the conflict chooser with different texts (M14)", async () => {
    const init = fixtureInit();
    const server = new FakeEdgServer(init);
    const alice = new EditorStore(init, depsFor(server, { newId: () => "alice-op" }));
    const bob = new EditorStore(init, depsFor(server, { newId: () => "bob-op" }));

    alice.submitOp({ type: "EditWord", opId: "alice-op", wordId: "0:0" as never, text: "hola" });
    await alice.flush();

    bob.submitOp({ type: "EditWord", opId: "bob-op", wordId: "0:0" as never, text: "bonjour" });
    // Bob's own realtime client also receives Alice's broadcasted op before
    // his own batch resolves — a genuinely different opId, so it must still
    // merge as a real remote edit.
    bob.absorbRemoteOps(
      [{ type: "EditWord", opId: "alice-op", wordId: "0:0" as never, text: "hola" }],
      2,
    );
    await bob.flush();

    const snapshot = bob.getSnapshot();
    expect(snapshot.conflicts).toHaveLength(1);
    expect(snapshot.conflicts[0]).toMatchObject({
      target: "word",
      targetId: "0:0",
      yours: "bonjour",
      theirs: "hola",
    });
    expect(snapshot.conflicts[0]!.yours).not.toBe(snapshot.conflicts[0]!.theirs);
  });

  // ---------------------------------------------------------------------
  // Acceptance criterion 3: undo/redo round-trips N random ops back to the
  // initial projection.
  // ---------------------------------------------------------------------

  /** Deterministic PRNG (mulberry32) — no dependency, a fixed seed reproduces a failure. */
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * The reversible op universe the property test draws from: every op here
   * has an *exact*, id-preserving inverse (`ops.test.ts` covers each in
   * isolation). `DeleteWord`/`InsertWordAfter` and `MergeSegments` are
   * deliberately excluded — their inverses are documented as
   * behaviourally-exact but id-changing (a fresh word/segment id), which
   * would make "back to the initial projection" a byte-inequality even
   * though nothing is visibly different; that claim is exercised directly in
   * `ops.test.ts` instead of by round-trip equality here.
   */
  function randomReversibleOp(random: () => number, opId: string): EdgOp {
    const pick = <T>(options: readonly T[]): T => {
      const index = Math.floor(random() * options.length);
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      return options[index] as T;
    };
    const kind = pick([
      "EditWord",
      "HideSegment",
      "SetEmphasis",
      "SetSegmentPosition",
      "SetStyle",
    ] as const);
    switch (kind) {
      case "EditWord":
        return {
          type: "EditWord",
          opId,
          wordId: pick(["0:0", "0:1", "0:2", "0:3"]) as never,
          text: pick(["a", "bb", "ccc"]),
        };
      case "HideSegment":
        return {
          type: "HideSegment",
          opId,
          segmentId: pick(["s1", "s2"]),
          hidden: pick([true, false]),
        };
      case "SetEmphasis":
        return {
          type: "SetEmphasis",
          opId,
          segmentId: pick(["s1", "s2"]),
          wordId: pick(["0:0", "0:1", "0:2", "0:3"]) as never,
          presetId: pick(["pop", "shake", null]),
        };
      case "SetSegmentPosition":
        return {
          type: "SetSegmentPosition",
          opId,
          segmentId: pick(["s1", "s2"]),
          position: pick([null, { x: 0.5, y: 0.8, anchor: "bottom-center" }]),
        };
      case "SetStyle":
        return {
          type: "SetStyle",
          opId,
          scope: "segment",
          segmentId: pick(["s1", "s2"]),
          overrides: { typography: { sizePct: pick([6, 8, 10]) } },
        };
    }
  }

  it("100 random reversible ops, undone in order, restore the initial projection", async () => {
    const init = fixtureInit();
    const server = new FakeEdgServer(init);
    const store = new EditorStore(init, depsFor(server));
    const initialProjection = server.projection();
    const initialWords = server.words();

    const random = mulberry32(20260902);
    for (let i = 0; i < 100; i += 1) {
      const op = randomReversibleOp(random, `op-${String(i)}`);
      store.submitOp(op);
    }
    expect(store.getSnapshot().state.words.get("0:0" as never)).toBeDefined();

    for (let i = 0; i < 100; i += 1) store.undo();

    const restored = store.getSnapshot().state;
    // Compare the visible shape (words, segments' addressable fields), not
    // `hot.meta.revision` or op ids minted along the way.
    expect([...restored.words.values()].map((w) => ({ wid: w.wid, t: w.t }))).toEqual(
      initialWords.map((w) => ({ wid: w.wid, t: w.t })),
    );
    for (const segment of initialProjection.segments) {
      const after = restored.segments.get(segment.id);
      expect(after?.hidden ?? false).toBe(segment.hidden ?? false);
      expect(after?.position ?? null).toEqual(segment.position ?? null);
      expect(after?.overrides ?? {}).toEqual(segment.overrides ?? {});
      expect(after?.emphasis ?? []).toEqual(segment.emphasis ?? []);
    }
    expect(store.getSnapshot().canUndo).toBe(false);
  });

  it("redo after undo replays the same ops and reaches the same state", () => {
    const init = fixtureInit();
    const server = new FakeEdgServer(init);
    const store = new EditorStore(init, depsFor(server));

    store.submitOp({ type: "EditWord", opId: "e1", wordId: "0:0" as never, text: "hola" });
    store.submitOp({ type: "HideSegment", opId: "e2", segmentId: "s2", hidden: true });

    store.undo();
    store.undo();
    expect(store.getSnapshot().state.words.get("0:0" as never)?.t).toBe("hello");
    expect(store.getSnapshot().state.segments.get("s2")?.hidden).not.toBe(true);

    store.redo();
    store.redo();
    expect(store.getSnapshot().state.words.get("0:0" as never)?.t).toBe("hola");
    expect(store.getSnapshot().state.segments.get("s2")?.hidden).toBe(true);
    expect(store.getSnapshot().canRedo).toBe(false);
  });
});
