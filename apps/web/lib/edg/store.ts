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
import { applyOps, fromProjection, newId } from "@montaj/edg";
import type { EdgHot, EdgOp, EdgState, Pass, Segment, TranscriptChunk } from "@montaj/edg";

import { EditHistory, type HistoryEntry } from "./history";
import { computeInverseOps, editWord, setSegmentText, type InverseState } from "./ops";
import { EdgOpQueue } from "./queue";

import type { OpBatchResponse, TextConflict } from "./client";

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
