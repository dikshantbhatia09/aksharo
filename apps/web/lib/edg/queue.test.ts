import { describe, expect, it, vi } from "vitest";

import type { EdgOp } from "@montaj/edg";

import { editWord } from "./ops";
import { EdgConflictError, EdgOpQueue, EdgTooStaleError, EdgTransientError } from "./queue";

import type { OpBatchResponse } from "./client";

let counter = 0;
function id(): string {
  counter += 1;
  return `op-${String(counter)}`;
}

/** A deterministic clock: `setTimeoutFn` fires the moment `runTimers` is called. */
function fakeClock(): {
  setTimeoutFn: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
  runTimers: () => void;
} {
  const pending: (() => void)[] = [];
  return {
    setTimeoutFn: (handler) => {
      pending.push(handler);
      return pending.length;
    },
    clearTimeoutFn: (handle) => {
      const index = (handle as number) - 1;
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      pending[index] = () => undefined;
    },
    runTimers: () => {
      const due = pending.splice(0, pending.length);
      for (const handler of due) handler();
    },
  };
}

function accept(revision: number): (body: { ops: EdgOp[] }) => OpBatchResponse {
  return (body) => ({
    revision,
    applied: body.ops.map((op) => op.opId),
    rebased: [],
    rejected: [],
  });
}

/**
 * The queue's own async chain (`flush` → `applyBatch` → `onBatch*` →
 * sometimes another `flush`) resolves over several microtasks, and its
 * length is an implementation detail, not something a test should count
 * ticks for. `vi.waitFor` polls the assertion with real timers until it
 * passes (or its own short timeout fires), which is what keeps this file
 * from depending on exactly how many `await Promise.resolve()`s the queue's
 * internals happen to need today.
 */
function settled<T>(assertion: () => T): Promise<T> {
  return vi.waitFor(assertion, { timeout: 1000, interval: 5 });
}

describe("EdgOpQueue", () => {
  it("debounces before sending, then sends the batch once", async () => {
    const clock = fakeClock();
    const applyBatch = vi.fn(
      async (body: { baseRevision: number; ops: EdgOp[]; clientOpIds: string[] }) =>
        Promise.resolve(accept(2)(body)),
    );
    const queue = new EdgOpQueue({
      applyBatch,
      baseRevision: 1,
      debounceMs: 250,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    queue.enqueue(editWord("0:0", "a", undefined, id));
    queue.enqueue(editWord("0:1", "b", undefined, id));
    expect(applyBatch).not.toHaveBeenCalled();

    clock.runTimers();
    await settled(() => expect(applyBatch).toHaveBeenCalledTimes(1));

    expect(applyBatch.mock.calls[0]?.[0].ops).toHaveLength(2);
    await settled(() => expect(queue.pendingOps()).toHaveLength(0));
    expect(queue.getBaseRevision()).toBe(2);
  });

  it("caps a batch at maxOpsPerBatch and drains the rest without waiting for another debounce", async () => {
    const clock = fakeClock();
    let call = 0;
    const applyBatch = vi.fn(
      async (body: { baseRevision: number; ops: EdgOp[]; clientOpIds: string[] }) => {
        call += 1;
        return Promise.resolve(accept(call)(body));
      },
    );
    const queue = new EdgOpQueue({
      applyBatch,
      baseRevision: 0,
      maxOpsPerBatch: 2,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    queue.enqueueMany([
      editWord("0:0", "a", undefined, id),
      editWord("0:1", "b", undefined, id),
      editWord("0:2", "c", undefined, id),
    ]);
    clock.runTimers();

    await settled(() => expect(queue.pendingOps()).toHaveLength(0));
    expect(applyBatch).toHaveBeenCalledTimes(2);
    expect(applyBatch.mock.calls[0]?.[0].ops).toHaveLength(2);
    expect(applyBatch.mock.calls[1]?.[0].ops).toHaveLength(1);
  });

  it("on a 409 conflict, rebases pending ops and surfaces the winner's text", async () => {
    const clock = fakeClock();
    const mine = editWord("0:0", "mine", undefined, id);
    const theirEdit = editWord("0:0", "theirs", undefined, id);

    const applyBatch = vi.fn(async () => {
      throw new EdgConflictError({
        latestRevision: 5,
        opsSince: [theirEdit],
        conflicts: [
          { opId: mine.opId, target: "word", targetId: "0:0", yours: "mine", theirs: "theirs" },
        ],
      });
    });

    const onConflict = vi.fn();
    const queue = new EdgOpQueue({
      applyBatch,
      baseRevision: 1,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onConflict,
    });

    queue.enqueue(mine);
    clock.runTimers();
    await settled(() => expect(onConflict).toHaveBeenCalledTimes(1));

    expect(queue.getBaseRevision()).toBe(5);
    // The conflicting op was rejected by the rebase table (rule 3), so it is
    // gone from pending — the caller resolves it explicitly, never retries it.
    expect(queue.pendingOps()).toHaveLength(0);
    expect(onConflict).toHaveBeenCalledWith(
      [{ opId: mine.opId, target: "word", targetId: "0:0", yours: "mine", theirs: "theirs" }],
      [theirEdit],
      5,
    );
  });

  it("a batch on a different word survives a conflict rebase and is retried", async () => {
    const clock = fakeClock();
    const conflicting = editWord("0:0", "mine", undefined, id);
    const other = editWord("0:1", "unrelated", undefined, id);
    const theirEdit = editWord("0:0", "theirs", undefined, id);

    let attempt = 0;
    const applyBatch = vi.fn(async (body: { ops: EdgOp[] }) => {
      attempt += 1;
      if (attempt === 1) {
        throw new EdgConflictError({
          latestRevision: 5,
          opsSince: [theirEdit],
          conflicts: [
            {
              opId: conflicting.opId,
              target: "word",
              targetId: "0:0",
              yours: "mine",
              theirs: "theirs",
            },
          ],
        });
      }
      return accept(6)({ ops: body.ops });
    });

    const queue = new EdgOpQueue({
      applyBatch,
      baseRevision: 1,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    queue.enqueueMany([conflicting, other]);
    clock.runTimers();

    await settled(() => expect(applyBatch).toHaveBeenCalledTimes(2));
    expect(applyBatch.mock.calls[1]?.[0].ops).toEqual([other]);
    await settled(() => expect(queue.pendingOps()).toHaveLength(0));
  });

  it("edg/too_stale calls onTooStale and does not retry the batch itself", async () => {
    const clock = fakeClock();
    const applyBatch = vi.fn(async () => {
      throw new EdgTooStaleError(500);
    });
    const onTooStale = vi.fn();
    const queue = new EdgOpQueue({
      applyBatch,
      baseRevision: 1,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onTooStale,
    });

    queue.enqueue(editWord("0:0", "a", undefined, id));
    clock.runTimers();
    await settled(() => expect(onTooStale).toHaveBeenCalledWith(500));

    // The regression this guards: `too_stale` must not leave `pending`
    // non-empty, or `flush()`'s own tail-check re-sends the same
    // unrebaseable batch forever (it did, once — an infinite retry loop that
    // only stopped at a heap-out-of-memory crash).
    expect(queue.pendingOps()).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(applyBatch).toHaveBeenCalledTimes(1);
  });

  it("resumeAfterReload clears the too_stale halt so the queue accepts new ops again", async () => {
    const clock = fakeClock();
    let stale = true;
    const applyBatch = vi.fn(async (body: { ops: EdgOp[] }) => {
      if (stale) throw new EdgTooStaleError(500);
      return accept(501)({ ops: body.ops });
    });
    const onTooStale = vi.fn();
    const queue = new EdgOpQueue({
      applyBatch,
      baseRevision: 1,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onTooStale,
    });

    queue.enqueue(editWord("0:0", "a", undefined, id));
    clock.runTimers();
    await settled(() => expect(onTooStale).toHaveBeenCalledTimes(1));

    stale = false;
    queue.resumeAfterReload(500);
    expect(queue.getBaseRevision()).toBe(500);

    const after = editWord("0:1", "b", undefined, id);
    queue.enqueue(after);
    clock.runTimers();
    await settled(() => expect(queue.pendingOps()).toHaveLength(0));
    expect(applyBatch).toHaveBeenCalledTimes(2);
    expect(queue.getBaseRevision()).toBe(501);
  });

  it("a transient failure keeps the batch pending and retries with backoff", async () => {
    const clock = fakeClock();
    let attempt = 0;
    const applyBatch = vi.fn(async (body: { ops: EdgOp[] }) => {
      attempt += 1;
      if (attempt === 1) throw new EdgTransientError("network down");
      return accept(2)({ ops: body.ops });
    });
    const onOffline = vi.fn();
    const onOnline = vi.fn();
    const queue = new EdgOpQueue({
      applyBatch,
      baseRevision: 1,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      random: () => 0,
      onOffline,
      onOnline,
    });

    queue.enqueue(editWord("0:0", "a", undefined, id));
    clock.runTimers(); // debounce -> first (failing) attempt
    await settled(() => expect(onOffline).toHaveBeenCalledTimes(1));
    expect(queue.pendingOps()).toHaveLength(1);

    clock.runTimers(); // retry timer -> second (succeeding) attempt
    await settled(() => expect(onOnline).toHaveBeenCalledTimes(1));

    expect(applyBatch).toHaveBeenCalledTimes(2);
    expect(queue.pendingOps()).toHaveLength(0);
  });

  it("absorbRemoteOps rebases pending ops against an out-of-band edg.ops event", () => {
    const conflicting = editWord("0:0", "mine", undefined, id);
    const theirEdit = editWord("0:0", "theirs", undefined, id);
    const onConflict = vi.fn();
    // A real (uncalled) `applyBatch`, and the queue is disposed at the end of
    // this test so its debounce timer never fires — this test asserts the
    // *local* rebase, not a network round trip.
    const applyBatch = vi.fn(async (body: { ops: EdgOp[] }) => accept(1)({ ops: body.ops }));
    const queue = new EdgOpQueue({ applyBatch, baseRevision: 1, onConflict });

    queue.enqueue(conflicting);
    queue.absorbRemoteOps([theirEdit], 5);

    expect(queue.getBaseRevision()).toBe(5);
    expect(queue.pendingOps()).toHaveLength(0);
    expect(onConflict).toHaveBeenCalledTimes(1);
    const [conflicts] = onConflict.mock.calls[0] as [{ yours: string; theirs: string }[]];
    expect(conflicts[0]).toMatchObject({ yours: "mine", theirs: "theirs" });

    queue.dispose();
  });

  it("auto-resolves a conflict silently when yours and theirs happen to be identical text", async () => {
    const clock = fakeClock();
    const mine = editWord("0:0", "same", undefined, id);
    const theirEdit = editWord("0:0", "same", undefined, id);

    const applyBatch = vi.fn(async () => {
      throw new EdgConflictError({
        latestRevision: 5,
        opsSince: [theirEdit],
        conflicts: [
          { opId: mine.opId, target: "word", targetId: "0:0", yours: "same", theirs: "same" },
        ],
      });
    });

    const onConflict = vi.fn();
    const queue = new EdgOpQueue({
      applyBatch,
      baseRevision: 1,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      onConflict,
    });

    queue.enqueue(mine);
    clock.runTimers();
    await settled(() => expect(queue.getBaseRevision()).toBe(5));

    expect(onConflict).not.toHaveBeenCalled();

    queue.dispose();
  });

  it("absorbRemoteOps drops an echo of this client's own pending op instead of conflicting it with itself", () => {
    const mine = editWord("0:0", "mine", undefined, id);
    const onConflict = vi.fn();
    const applyBatch = vi.fn(async (body: { ops: EdgOp[] }) => accept(1)({ ops: body.ops }));
    const queue = new EdgOpQueue({ applyBatch, baseRevision: 1, onConflict });

    queue.enqueue(mine);
    // The realtime broadcast of this exact op — same opId — beats the HTTP
    // response back to this same client, as M10's gate-a repro found.
    queue.absorbRemoteOps([mine], 2);

    expect(onConflict).not.toHaveBeenCalled();
    // Not a real conflict, so nothing was rebased away — the op is still
    // pending, waiting for the real batch response to confirm it.
    expect(queue.pendingOps()).toEqual([mine]);
    expect(queue.getBaseRevision()).toBe(2);

    queue.dispose();
  });

  it("absorbRemoteOps ignores an out-of-order echo of an already-confirmed op", async () => {
    const mine = editWord("0:0", "mine", undefined, id);
    const onConflict = vi.fn();
    const applyBatch = vi.fn(async (body: { ops: EdgOp[] }) => accept(2)({ ops: body.ops }));
    const clock = fakeClock();
    const queue = new EdgOpQueue({
      applyBatch,
      baseRevision: 1,
      onConflict,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    queue.enqueue(mine);
    clock.runTimers();
    await settled(() => expect(queue.pendingOps()).toHaveLength(0));

    // The echo of `mine` finally arrives after the batch already confirmed
    // it and it left `pending` — a stale, out-of-order broadcast.
    queue.absorbRemoteOps([mine], 2);

    expect(onConflict).not.toHaveBeenCalled();
    expect(queue.pendingOps()).toHaveLength(0);

    queue.dispose();
  });

  it("flushNow sends immediately, bypassing the debounce", async () => {
    const applyBatch = vi.fn(async (body: { ops: EdgOp[] }) => accept(2)({ ops: body.ops }));
    const queue = new EdgOpQueue({ applyBatch, baseRevision: 1, debounceMs: 10_000 });
    queue.enqueue(editWord("0:0", "a", undefined, id));
    await queue.flushNow();
    expect(applyBatch).toHaveBeenCalledTimes(1);
    queue.dispose();
  });
});
