/**
 * The op queue: batches local ops to `POST /projects/{id}/edg/ops`, reconciles
 * `applied` / `rebased` / `rejected`, and resolves a 409 by rebasing the still-
 * pending ops against `opsSince` — locally, with the identical
 * `@montaj/edg/ops` `rebaseOps` the server ran, per `packages/edg/README.md`'s
 * rebase transform table.
 *
 * The queue owns **only** the wire protocol: what is pending, when it is sent,
 * and what the server said. It does not touch an `EdgState` — that is
 * `store.ts`'s job, which derives the optimistic projection as
 * `applyOps(serverConfirmedState, queue.pendingOps())` and recomputes it
 * whenever the queue's pending list changes. Keeping the split means this
 * module can be tested with a fake API and no DOM, exactly as the brief asks.
 */
import { rebaseOps } from "@montaj/edg";
import type { EdgOp, OpRejection } from "@montaj/edg";

import type { OpBatchResponse, OpConflictDetails, TextConflict } from "./client";

/**
 * The brief (`A15-web-editor-transcript.md` §2) says "debounce 250 ms, max 50
 * ops"; the orchestrator's later "Facts decided" summary says "debounced
 * ~400 ms" without a batch cap. The two disagree and both are nominally
 * authoritative — reported in the final message rather than silently picked.
 * This module follows the brief's own numbers, since it is the work package
 * document, and takes both as overridable options either way.
 */
export const DEFAULT_DEBOUNCE_MS = 250;
export const DEFAULT_MAX_OPS_PER_BATCH = 50;

/** Thrown by the injected `applyBatch` to report a 409 `edg/conflict`. */
export class EdgConflictError extends Error {
  override readonly name = "EdgConflictError";
  constructor(readonly details: OpConflictDetails) {
    super("edg/conflict");
  }
}

/** Thrown by the injected `applyBatch` to report a 409 `edg/too_stale`. */
export class EdgTooStaleError extends Error {
  override readonly name = "EdgTooStaleError";
  constructor(readonly latestRevision: number) {
    super("edg/too_stale");
  }
}

/** Thrown for anything else (network, 5xx, rate limit) — the batch is retried. */
export class EdgTransientError extends Error {
  override readonly name = "EdgTransientError";
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface EdgOpQueueOptions {
  /** POST /projects/{id}/edg/ops, or a fake in tests. */
  applyBatch(body: {
    baseRevision: number;
    ops: EdgOp[];
    clientOpIds: string[];
  }): Promise<OpBatchResponse>;
  /** The revision the queue starts reconciled to (from the initial `GET /edg`). */
  baseRevision: number;
  debounceMs?: number;
  maxOpsPerBatch?: number;
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  random?: () => number;

  /** A batch landed: `applied`/`rebased` opIds confirmed, `revision` advanced. */
  onBatchApplied?: (result: {
    /** The ops as sent, in submission order — for replaying `applied`/`rebased` onto server state. */
    batch: EdgOp[];
    applied: string[];
    rebased: string[];
    revision: number;
  }) => void;
  /** Ops the server rejected outright (not a conflict — `stale`, `invariant`, ...). */
  onRejected?: (rejections: OpRejection[]) => void;
  /** A 409 conflict: the remote ops now merged in, and the texts to choose between. */
  onConflict?: (conflicts: TextConflict[], opsSince: EdgOp[], latestRevision: number) => void;
  /** More than 200 revisions behind, or a state replacement in between — reload. */
  onTooStale?: (latestRevision: number) => void;
  /** The queue is retrying after a network failure; `attempt` is 1-based. */
  onOffline?: (attempt: number, delayMs: number) => void;
  onOnline?: () => void;
}

const MAX_BACKOFF_MS = 30_000;

function backoffDelayMs(attempt: number, random: () => number): number {
  const exponential = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
  return Math.round(exponential * (0.5 + random() * 0.5));
}

/**
 * Batches ops optimistically, debounced, with server-side-identical rebase on
 * conflict and an offline retry buffer. `enqueue` never throws: every failure
 * mode is reported through the callbacks above, because a queue that can throw
 * out from under a keystroke is a queue nobody can build a text editor on.
 */
export class EdgOpQueue {
  private readonly options: EdgOpQueueOptions;
  private pending: EdgOp[] = [];
  private inFlight = false;
  private offline = false;
  private offlineAttempt = 0;
  private debounceHandle: unknown = null;
  private retryHandle: unknown = null;
  private baseRevision: number;
  private disposed = false;
  /** `true` after `edg/too_stale`, until `resumeAfterReload` — see there. */
  private stalled = false;
  /**
   * Every opId this client has ever minted and enqueued, kept for the life of
   * the queue. `absorbRemoteOps` uses this to recognize a realtime `edg.ops`
   * broadcast of this session's *own* just-submitted batch (the server
   * broadcasts to every room member, sender included — CONTRACTS §7 does not
   * exempt the origin) and drop it before rebasing: without this, an echo
   * that arrives while the op is still `pending` (the common case — the
   * websocket push typically beats the HTTP response) gets rebased against
   * itself, and `conflictsFrom` raises a same-word conflict whose "yours" and
   * "theirs" are the identical text of the one op the user actually made.
   */
  private readonly submittedOpIds = new Set<string>();

  constructor(options: EdgOpQueueOptions) {
    this.options = options;
    this.baseRevision = options.baseRevision;
  }

  /** Ops not yet confirmed by the server, in submission order. */
  pendingOps(): readonly EdgOp[] {
    return this.pending;
  }

  getBaseRevision(): number {
    return this.baseRevision;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Queue one op, debounced. Applied optimistically by the caller before this. */
  enqueue(op: EdgOp): void {
    this.pending.push(op);
    this.submittedOpIds.add(op.opId);
    this.scheduleFlush();
  }

  /** Queue several ops as one action ("Replace all", a resegment retry). */
  enqueueMany(ops: readonly EdgOp[]): void {
    if (ops.length === 0) return;
    this.pending.push(...ops);
    for (const op of ops) this.submittedOpIds.add(op.opId);
    this.scheduleFlush();
  }

  /** Send whatever is pending right now, bypassing the debounce (blur, unmount). */
  flushNow(): Promise<void> {
    this.clearDebounce();
    return this.flush();
  }

  /**
   * Merge remote ops that arrived out of band — a realtime `edg.ops` event —
   * into the queue's notion of "since". The pending ops are rebased against
   * them, exactly as a 409 would, so a queue that had local edits in flight
   * when a teammate's edit arrived does not silently overwrite it on its next
   * flush.
   *
   * Ops this same client submitted (their `opId` is in {@link submittedOpIds})
   * are filtered out first — an echo of this session's own batch, not a
   * remote edit — so they are never rebased against the very pending op they
   * are an echo of. Their `opId` is already applied or rejected by the actual
   * batch response (`onBatchSucceeded`/`onBatchFailed`), which is what really
   * removes them from `pending`; the echo carries no new information for this
   * client and is dropped silently, whether it arrives before that response
   * (the common race) or after (an out-of-order echo, by which point it is
   * already gone from `pending` and this is a no-op either way).
   */
  absorbRemoteOps(ops: readonly EdgOp[], revision: number): void {
    const remote = ops.filter((op) => !this.submittedOpIds.has(op.opId));
    if (remote.length > 0 && this.pending.length > 0) {
      const before = this.pending;
      const { rebased, rejected } = rebaseOps(before, remote);
      this.pending = rebased;
      const conflictRejections = rejected.filter((entry) => entry.reason === "conflict");
      if (conflictRejections.length > 0) {
        const realConflicts = dropIdenticalConflicts(
          conflictsFrom(conflictRejections, before, remote),
        );
        if (realConflicts.length > 0) {
          this.options.onConflict?.(realConflicts, [...remote], revision);
        }
      }
      const other = rejected.filter((entry) => entry.reason !== "conflict");
      if (other.length > 0) this.options.onRejected?.(other);
    }
    this.baseRevision = Math.max(this.baseRevision, revision);
  }

  dispose(): void {
    this.disposed = true;
    this.clearDebounce();
    this.clearRetry();
  }

  /**
   * Clears the `edg/too_stale` halt after the caller has reloaded the
   * document. `newBaseRevision` is the freshly-reloaded revision; any ops
   * still pending from before the stall were already dropped when it fired
   * (`onBatchFailed`'s `EdgTooStaleError` branch) — there is nothing safe to
   * resend against a base that old, which is the same reason a restore
   * cannot resurrect a dangling id.
   */
  resumeAfterReload(newBaseRevision: number): void {
    this.stalled = false;
    this.baseRevision = newBaseRevision;
  }

  private scheduleFlush(): void {
    if (this.disposed || this.stalled) return;
    this.clearDebounce();
    const debounceMs = this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const schedule = this.options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    this.debounceHandle = schedule(() => {
      this.debounceHandle = null;
      void this.flush();
    }, debounceMs);
  }

  private clearDebounce(): void {
    if (this.debounceHandle === null) return;
    const clear = this.options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never));
    clear(this.debounceHandle);
    this.debounceHandle = null;
  }

  private clearRetry(): void {
    if (this.retryHandle === null) return;
    const clear = this.options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never));
    clear(this.retryHandle);
    this.retryHandle = null;
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.stalled || this.inFlight || this.pending.length === 0) return;
    const maxOps = this.options.maxOpsPerBatch ?? DEFAULT_MAX_OPS_PER_BATCH;
    const batch = this.pending.slice(0, maxOps);

    this.inFlight = true;
    try {
      const response = await this.options.applyBatch({
        baseRevision: this.baseRevision,
        ops: batch,
        clientOpIds: batch.map((op) => op.opId),
      });
      this.onBatchSucceeded(batch, response);
    } catch (error) {
      this.onBatchFailed(error);
    } finally {
      this.inFlight = false;
    }

    // More queued while this batch was in flight, or a batch bigger than the
    // cap still has a remainder: keep draining without waiting for another
    // debounce window — a user typing fast should not see their queue stall.
    if (!this.disposed && this.pending.length > 0 && !this.offline) void this.flush();
  }

  /** Every op in the sent batch is terminal (applied, rebased or rejected) — drop it from pending. */
  private onBatchSucceeded(batch: readonly EdgOp[], response: OpBatchResponse): void {
    const batchIds = new Set(batch.map((op) => op.opId));
    this.pending = this.pending.filter((op) => !batchIds.has(op.opId));
    this.baseRevision = response.revision;
    this.offlineAttempt = 0;
    if (this.offline) {
      this.offline = false;
      this.options.onOnline?.();
    }
    this.options.onBatchApplied?.({
      batch: [...batch],
      applied: response.applied,
      rebased: response.rebased,
      revision: response.revision,
    });
    if (response.rejected.length > 0) this.options.onRejected?.(response.rejected);
  }

  private onBatchFailed(error: unknown): void {
    if (error instanceof EdgConflictError) {
      // The whole pending list — not just the batch that was sent — is against
      // the same stale `baseRevision`, so all of it is rebased together.
      const before = this.pending;
      this.baseRevision = error.details.latestRevision;
      const { rebased, rejected } = rebaseOps(before, error.details.opsSince);
      this.pending = rebased;
      const serverConflicts = error.details.conflicts ?? [];
      const conflictIds = new Set(serverConflicts.map((entry) => entry.opId));
      const other = rejected.filter((entry) => !conflictIds.has(entry.opId));
      if (other.length > 0) this.options.onRejected?.(other);
      const realConflicts = dropIdenticalConflicts(serverConflicts);
      if (realConflicts.length > 0) {
        this.options.onConflict?.(
          realConflicts,
          error.details.opsSince,
          error.details.latestRevision,
        );
      }
      if (!this.disposed && this.pending.length > 0) void this.flush();
      return;
    }
    if (error instanceof EdgTooStaleError) {
      // Too far behind to rebase (`packages/edg` README: "reload rather than
      // replay"). The pending ops cannot be salvaged against a base this old,
      // and leaving them in `pending` would otherwise re-trigger the same
      // batch on every `flush()` tail-check forever — `stalled` blocks that
      // until `resumeAfterReload` clears it. The ops themselves are not
      // silently lost: `EditorStore` still holds them in its undo history and
      // the caller's own optimistic state until a reload replaces both.
      this.stalled = true;
      this.pending = [];
      this.options.onTooStale?.(error.latestRevision);
      return;
    }
    // Network failure or 5xx: the batch stays pending — nothing above removed
    // it — and the queue backs off before retrying, exactly as
    // `RealtimeClient` does for a dropped socket.
    this.offlineAttempt += 1;
    this.offline = true;
    const random = this.options.random ?? Math.random;
    const explicitDelay = error instanceof EdgTransientError ? error.retryAfterMs : undefined;
    const delayMs = explicitDelay ?? backoffDelayMs(this.offlineAttempt, random);
    this.options.onOffline?.(this.offlineAttempt, delayMs);
    this.clearRetry();
    const schedule = this.options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    this.retryHandle = schedule(() => {
      this.retryHandle = null;
      // `offline` stays `true` until the retry actually lands —
      // `onBatchSucceeded` is what clears it and fires `onOnline`. Clearing
      // it here instead would make that check always find `offline` already
      // false, so a reconnect would never tell the caller it reconnected.
      void this.flush();
    }, delayMs);
  }
}

/**
 * Belt-and-suspenders on top of the `submittedOpIds` self-echo filter above:
 * a conflict whose `yours` and `theirs` text are identical carries nothing
 * for the user to choose between (whichever they pick lands the same text),
 * so it is dropped rather than shown — the dialog title itself would
 * otherwise read as a bug ("someone else edited this" over two identical
 * strings) even in a case this module did not anticipate, such as two
 * genuinely different clients coincidentally typing the same correction.
 */
function dropIdenticalConflicts(conflicts: readonly TextConflict[]): TextConflict[] {
  return conflicts.filter((conflict) => conflict.yours !== conflict.theirs);
}

/** Builds `{yours, theirs}` for a locally-rebased conflict (no 409 body to read one from). */
function conflictsFrom(
  rejected: readonly OpRejection[],
  incoming: readonly EdgOp[],
  opsSince: readonly EdgOp[],
): TextConflict[] {
  const conflicts: TextConflict[] = [];
  for (const rejection of rejected) {
    const mine = incoming.find((op) => op.opId === rejection.opId);
    if (mine === undefined) continue;
    if (mine.type === "EditWord") {
      const winner = [...opsSince]
        .reverse()
        .find((op) => op.type === "EditWord" && op.wordId === mine.wordId);
      conflicts.push({
        opId: mine.opId,
        target: "word",
        targetId: mine.wordId,
        ...(mine.script === undefined ? {} : { script: mine.script }),
        yours: mine.text,
        theirs: winner !== undefined && winner.type === "EditWord" ? winner.text : "",
      });
    } else if (mine.type === "SetSegmentText") {
      const winner = [...opsSince]
        .reverse()
        .find(
          (op) =>
            op.type === "SetSegmentText" &&
            op.segmentId === mine.segmentId &&
            op.script === mine.script,
        );
      conflicts.push({
        opId: mine.opId,
        target: "segment",
        targetId: mine.segmentId,
        script: mine.script,
        yours: mine.text,
        theirs: winner !== undefined && winner.type === "SetSegmentText" ? winner.text : "",
      });
    }
  }
  return conflicts;
}
