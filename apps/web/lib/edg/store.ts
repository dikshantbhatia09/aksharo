/**
 * `EditorStore` — the EDG projection plus everything the transcript editor
 * does to it: optimistic op application, the batching queue, undo/redo and
 * conflict tracking.
 *
 * A plain class, not a React hook, on purpose: `store.test.ts` drives it with
 * a fake `applyBatch` and a fake clock exactly as the brief's "store unit
 * tests with a fake API" asks, with no DOM in the loop. `use-editor-store.ts`
 * wraps one instance with `useSyncExternalStore`, the same pattern
 * `@montaj/api-client`'s `SessionStore`/`useSession` uses for state written
 * from outside React (a queue retry, a realtime event).
 */
import { applyOps, fromProjection, newId, toTranscriptChunks } from "@montaj/edg";
import type { EdgHot, EdgOp, EdgState, Pass, Segment, TranscriptChunk } from "@montaj/edg";

import { EditHistory, type HistoryEntry } from "./history";
import { computeInverseOps, editWord, setSegmentText, type InverseState } from "./ops";
import { EdgOpQueue } from "./queue";

import type { OpBatchResponse, TextConflict } from "./client";
import type { AksharoDesktopWindowApi } from "../desktop";

export interface EditorStoreDeps {
  /** `POST /projects/{id}/edg/ops`. Throws `EdgConflictError` / `EdgTooStaleError` / `EdgTransientError`. */
  applyBatch(body: {
    baseRevision: number;
    ops: EdgOp[];
    clientOpIds: string[];
  }): Promise<OpBatchResponse>;
  /** `POST /projects/{id}/edg/resegment`. */
  resegment(params: {
    maxChars: number;
    maxLines: number;
    minMs: number;
    maxMs: number;
    dropFillers?: boolean;
  }): Promise<OpBatchResponse>;
  /**
   * Re-reads the document after a resegment (the response never carries the
   * document, D29 — the client refetches). Also used to recover from
   * `edg/too_stale`.
   */
  reloadDocument(): Promise<{ hot: EdgHot; segments: Segment[]; passes: Pass[]; revision: number }>;
  debounceMs?: number;
  maxOpsPerBatch?: number;
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  random?: () => number;
  /** Injected in tests for deterministic ids; defaults to `@montaj/edg`'s `newId`. */
  newId?: () => string;
}

export interface EditorStoreInit {
  hot: EdgHot;
  segments: Segment[];
  passes: Pass[];
  chunks: TranscriptChunk[];
  revision: number;
}

export interface EditorSnapshot {
  readonly state: EdgState;
  readonly serverRevision: number;
  readonly pendingCount: number;
  readonly offline: boolean;
  readonly conflicts: readonly TextConflict[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly tooStale: boolean;
  readonly lastError: string | undefined;
}

type Listener = () => void;

/** How the queue's `enqueueMany` groups ops for undo; also used for label display. */
export interface SubmitOptions {
  readonly label?: string;
}

export class EditorStore {
  private readonly deps: EditorStoreDeps;
  private readonly mintId: () => string;
  private serverState: EdgState;
  private localState: EdgState;
  private readonly queue: EdgOpQueue;
  private readonly history = new EditHistory();
  private conflicts: TextConflict[] = [];
  private offline = false;
  private tooStale = false;
  private lastError: string | undefined;
  private readonly listeners = new Set<Listener>();
  private snapshot: EditorSnapshot;

  constructor(init: EditorStoreInit, deps: EditorStoreDeps) {
    this.deps = deps;
    this.mintId = deps.newId ?? newId;
    this.serverState = fromProjection(
      { ...init.hot, segments: init.segments, passes: init.passes },
      { chunks: init.chunks },
    );
    this.localState = this.serverState;
    this.queue = new EdgOpQueue({
      applyBatch: (body) => this.deps.applyBatch(body),
      baseRevision: init.revision,
      ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
      ...(deps.maxOpsPerBatch === undefined ? {} : { maxOpsPerBatch: deps.maxOpsPerBatch }),
      ...(deps.setTimeoutFn === undefined ? {} : { setTimeoutFn: deps.setTimeoutFn }),
      ...(deps.clearTimeoutFn === undefined ? {} : { clearTimeoutFn: deps.clearTimeoutFn }),
      ...(deps.random === undefined ? {} : { random: deps.random }),
      onBatchApplied: (result) => {
        this.advanceServerState(result.batch, result.applied, result.rebased, result.revision);
        this.recomputeLocal();
      },
      onRejected: () => {
        // Rejected ops are already gone from `queue.pendingOps()`; recomputing
        // local state is enough to make them visibly disappear — no rollback
        // bookkeeping needed (the whole point of deriving local from pending).
        this.recomputeLocal();
      },
      onConflict: (conflicts, opsSince, latestRevision) => {
        this.serverState = applyOps(this.serverState, opsSince, {
          source: "web",
          revision: latestRevision,
        }).state;
        this.conflicts = [...this.conflicts, ...conflicts];
        this.recomputeLocal();
      },
      onTooStale: () => {
        this.tooStale = true;
        this.notify();
      },
      onOffline: () => {
        this.offline = true;
        this.notify();
      },
      onOnline: () => {
        this.offline = false;
        this.notify();
      },
    });
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): EditorSnapshot => this.snapshot;

  // -------------------------------------------------------------------------
  // Submitting ops
  // -------------------------------------------------------------------------

  /** One op, as one undo step. */
  submitOp(op: EdgOp, options?: SubmitOptions): void {
    this.submitOps([op], options);
  }

  /** Several ops as one undo step ("Replace all", "Fix spelling everywhere"). */
  submitOps(ops: readonly EdgOp[], options?: SubmitOptions): void {
    if (ops.length === 0) return;
    let running = this.localState;
    const forwardInverses: EdgOp[] = [];
    for (const op of ops) {
      const inverseState: InverseState = {
        hot: running.hot,
        segments: running.segments,
        words: running.words,
        items: running.items,
      };
      forwardInverses.push(...computeInverseOps(op, inverseState, this.mintId, this.mintId));
      running = applyOps(running, [op], { source: "web" }).state;
    }
    this.localState = running;
    this.queue.enqueueMany([...ops]);
    this.history.record({
      actionId: this.mintId(),
      ops,
      inverseOps: forwardInverses.reverse(),
      ...(options?.label === undefined ? {} : { label: options.label }),
    });
    this.notify();
  }

  undo(): void {
    const entry = this.history.undo();
    if (entry === undefined) return;
    this.replay(entry.inverseOps);
  }

  redo(): void {
    const entry = this.history.redo();
    if (entry === undefined) return;
    this.replay(entry.ops);
  }

  /** Re-applies a recorded action's ops under fresh op ids (the originals already landed once). */
  private replay(ops: readonly EdgOp[]): void {
    const reissued = ops.map((op) => ({ ...op, opId: this.mintId() }) as EdgOp);
    let running = this.localState;
    for (const op of reissued) running = applyOps(running, [op], { source: "web" }).state;
    this.localState = running;
    this.queue.enqueueMany(reissued);
    this.notify();
  }

  /** Force-send whatever is pending; call before a resegment or on unmount. */
  async flush(): Promise<void> {
    await this.queue.flushNow();
  }

  /**
   * A realtime `edg.ops` event from another surface (CONTRACTS §7). Advances
   * `serverState` and rebases any still-pending local ops against it, exactly
   * as a 409 from this store's own batch would — so an edit that landed while
   * a batch was mid-flight is merged, not overwritten, and a genuine
   * same-word collision still raises the chooser rather than picking a side.
   * Applying is idempotent (`appliedOpIds`), so an echo of this session's own
   * batch is a safe no-op.
   */
  absorbRemoteOps(ops: readonly EdgOp[], revision: number): void {
    if (ops.length > 0) {
      this.serverState = applyOps(this.serverState, ops, { source: "web", revision }).state;
    }
    this.queue.absorbRemoteOps(ops, revision);
    this.recomputeLocal();
  }

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------

  /**
   * The user chose "mine" or "theirs" for one conflict. Either way the choice
   * is submitted as a fresh, ordinary op — there is no special "resolve"
   * endpoint, because a resolution is just the next edit, made with full
   * knowledge of what it is overwriting.
   */
  resolveConflict(opId: string, choice: "mine" | "theirs"): void {
    const conflict = this.conflicts.find((entry) => entry.opId === opId);
    if (conflict === undefined) return;
    this.conflicts = this.conflicts.filter((entry) => entry.opId !== opId);
    const text = choice === "mine" ? conflict.yours : conflict.theirs;
    const script = (conflict.script ?? "roman") as "roman" | "native" | "en";
    const op: EdgOp =
      conflict.target === "word"
        ? editWord(
            conflict.targetId,
            text,
            conflict.script === undefined ? undefined : script,
            this.mintId,
          )
        : setSegmentText(conflict.targetId, script, text, this.mintId);
    // Not routed through `submitOps`: a conflict resolution should not itself
    // become an undoable step that, undone, resurrects the conflict.
    this.localState = applyOps(this.localState, [op], { source: "web" }).state;
    this.queue.enqueueMany([op]);
    this.notify();
  }

  dismissConflict(opId: string): void {
    this.conflicts = this.conflicts.filter((entry) => entry.opId !== opId);
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Resegment ("Reflow captions")
  // -------------------------------------------------------------------------

  /**
   * `Resegment` is server-minted (the brief: the API "mints the Resegment op
   * so the audited record ... carries an id this API can vouch for") and, per
   * D29, its response never carries the resulting document — so this reloads
   * the document afterwards rather than trying to predict the new segment ids
   * locally. It also clears history: every previous segment id is tombstoned,
   * so an old undo entry could only fail against the new document.
   */
  async resegment(params: {
    maxChars: number;
    maxLines: number;
    minMs: number;
    maxMs: number;
    dropFillers?: boolean;
  }): Promise<void> {
    await this.flush();
    await this.deps.resegment(params);
    await this.reload();
  }

  /** Re-reads the whole document from the server — also how `edg/too_stale` recovers. */
  async reload(): Promise<void> {
    const fresh = await this.deps.reloadDocument();
    // Words are untouched by a resegment (or by `edg/too_stale` recovery,
    // which never rewrites the transcript either) — the existing word index
    // carries over rather than re-fetching transcript chunks.
    this.serverState = fromProjection(
      { ...fresh.hot, segments: fresh.segments, passes: fresh.passes },
      { wordIndex: this.serverState.words, chunkBounds: this.serverState.chunks },
    );
    this.localState = this.serverState;
    this.history.clear();
    this.conflicts = [];
    this.tooStale = false;
    this.lastError = undefined;
    // `edg/too_stale` halts the queue (`queue.ts`'s `stalled`) because
    // nothing pending could be rebased against a base that old; this is the
    // one place that resumes it, now that the base really has moved.
    this.queue.resumeAfterReload(fresh.revision);
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private advanceServerState(
    batch: readonly EdgOp[],
    applied: readonly string[],
    rebased: readonly string[],
    revision: number,
  ): void {
    const landed = new Set([...applied, ...rebased]);
    const landedOps = batch.filter((op) => landed.has(op.opId));
    this.serverState = applyOps(this.serverState, landedOps, { source: "web", revision }).state;
  }

  private recomputeLocal(): void {
    this.localState = applyOps(this.serverState, this.queue.pendingOps(), { source: "web" }).state;
    this.notify();
  }

  private buildSnapshot(): EditorSnapshot {
    return {
      state: this.localState,
      serverRevision: this.queue.getBaseRevision(),
      pendingCount: this.queue.pendingOps().length,
      offline: this.offline,
      conflicts: this.conflicts,
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
      tooStale: this.tooStale,
      lastError: this.lastError,
    };
  }

  private notify(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }
}

export type { HistoryEntry };

// -----------------------------------------------------------------------------
// Local mode (brief C04 §2): "the hosted editor detects window.aksharoDesktop.
// local and runs EditorStore in local mode against the IPC (no API calls for
// local projects)".
//
// `EditorStore` never talks to a transport directly — every write goes through
// the three functions on `EditorStoreDeps`. For a cloud project those are
// `@montaj/api-client` HTTP calls (`apps/web/lib/edg/client.ts`); for a local
// project they are IPC calls to `apps/desktop`'s `LocalStore`
// (`window.aksharoDesktop.local`) instead — the editor's own code (undo/redo,
// optimistic apply, conflict UI) is exactly the same either way, which is the
// point of the seam.
//
// A local project has exactly one writer, so there is no rebase and no
// conflict to raise: `applyBatch` always applies against this module's own
// authoritative `EdgState` (there being no separate server to disagree with)
// and persists the result via `local.saveEdgSnapshot` — a whole-document
// write, not an appended op log (`local_edg_snapshots` stores one full
// revision each; see `apps/desktop/README.md`'s "Local mode" section).
//
// Local store gains `local_transcript_chunks` (brief C04b §1), one row per
// `chunkIdx`, kept current — so a local project's `EditorStore` now runs the
// full op set through `packages/edg`, chunks included: `EditWord`,
// `DeleteWord`, `SetWordTiming` and `InsertWordAfter` resolve against a real
// word index, and `Resegment` (below) works exactly like the cloud path,
// because `applyResegment` (`packages/edg/src/ops/apply.ts`) only ever reads
// `state.words` — it does not care whether that index was built from a
// database round trip or, as here, from `local_transcript_chunks`.
type LocalDesktopApi = NonNullable<AksharoDesktopWindowApi["local"]>;

/** Thrown by a local `resegment()` when the project has no transcript chunks saved yet. */
export class LocalResegmentUnsupportedError extends Error {
  constructor() {
    super(
      "Resegmenting a local project needs the transcript — import media and transcribe " +
        "before resegmenting, or edit segments directly instead.",
    );
    this.name = "LocalResegmentUnsupportedError";
  }
}

/** Builds `EditorStoreInit` for a local project from its latest saved snapshot, or a blank one for a new project. */
export async function loadLocalEditorInit(
  local: LocalDesktopApi,
  projectId: string,
): Promise<EditorStoreInit> {
  const snapshot = await local.latestSnapshot(projectId);
  if (snapshot === null) {
    throw new Error(
      `local project ${projectId} has no saved EDG snapshot yet — save one before opening the editor`,
    );
  }
  const hot = snapshot.hot as EdgHot;
  const segments = snapshot.segments as Segment[];
  const chunks = snapshot.chunks as TranscriptChunk[];
  return { hot, segments, passes: [], chunks, revision: snapshot.revision };
}

/**
 * `EditorStoreDeps` backed by the desktop's local IPC instead of the API
 * (brief C04 §2). Seed `EditorStore`'s own `init` from
 * {@link loadLocalEditorInit} first, then build these deps from the exact
 * same `hot`/`segments` so both start from one document.
 */
export function createLocalEditorStoreDeps(input: {
  local: LocalDesktopApi;
  projectId: string;
  init: EditorStoreInit;
}): EditorStoreDeps {
  let state = fromProjection(
    { ...input.init.hot, segments: input.init.segments, passes: input.init.passes },
    { chunks: input.init.chunks },
  );
  let revision = input.init.revision;

  /**
   * Touches a word (any op besides a pure segment-level one) since the last
   * save: `persist` sends chunks only when something changed, matching
   * `EdgRepository.persistWords`'s "only touched chunks move" — a save that
   * never resolved a word id writes `hot`/`segments` alone, exactly as
   * before this WP, so an all-segment-level history never gains a
   * `local_transcript_chunks` write it did not need.
   */
  async function persist(wordsTouched: boolean): Promise<void> {
    const segments = state.segmentOrder
      .map((id) => state.segments.get(id))
      .filter((segment): segment is Segment => segment !== undefined);
    await input.local.saveEdgSnapshot({
      projectId: input.projectId,
      hot: state.hot,
      segments,
      ...(wordsTouched ? { chunks: toTranscriptChunks(state) } : {}),
    });
  }

  /** Every op kind that can only have changed via the transcript, not just the segment list. */
  const WORD_OP_TYPES = new Set([
    "EditWord",
    "DeleteWord",
    "SetWordTiming",
    "InsertWordAfter",
    "Resegment",
  ]);

  return {
    async applyBatch(body) {
      const result = applyOps(state, body.ops, { source: "desktop" });
      const changed = result.applied.length > result.skipped.length;
      if (changed) {
        state = result.state;
        revision += 1;
        const wordsTouched = body.ops.some((op) => WORD_OP_TYPES.has(op.type));
        await persist(wordsTouched);
      }
      return {
        revision,
        applied: result.applied,
        rebased: [],
        rejected: result.rejected,
      };
    },

    /**
     * A local project has exactly one writer, so this mints the `Resegment`
     * op itself (the cloud path's `EdgService.resegment` does the same,
     * "the server mints the op so the audited record carries an id this API
     * can vouch for" — here, the local store is that authority) and applies
     * it against this module's own state, same as `applyBatch`.
     */
    async resegment(params) {
      if (state.words.size === 0) throw new LocalResegmentUnsupportedError();
      const op: EdgOp = { opId: newId(), type: "Resegment", ...params } as EdgOp;
      const result = applyOps(state, [op], {
        source: "desktop",
        ...(params.dropFillers === undefined ? {} : { dropFillers: params.dropFillers }),
      });
      state = result.state;
      revision += 1;
      await persist(true);
      return {
        revision,
        applied: result.applied,
        rebased: [],
        rejected: result.rejected,
      };
    },

    async reloadDocument() {
      const snapshot = await input.local.latestSnapshot(input.projectId);
      if (snapshot === null) {
        return { hot: state.hot, segments: [], passes: [], revision };
      }
      const hot = snapshot.hot as EdgHot;
      const segments = snapshot.segments as Segment[];
      const chunks = snapshot.chunks as TranscriptChunk[];
      state = fromProjection({ ...hot, segments, passes: [] }, { chunks });
      revision = snapshot.revision;
      return { hot, segments, passes: [], revision };
    },
  };
}
