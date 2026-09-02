import type { QueuedTelemetryEvent, TelemetryOfflineQueue } from "./offline-queue.js";

const BATCH_SIZE = 50;

export interface FlushDeps {
  readonly queue: TelemetryOfflineQueue;
  /** Posts one batch; throws (or rejects) on any failure, including offline. */
  readonly postEvents: (events: readonly QueuedTelemetryEvent[]) => Promise<void>;
}

/**
 * Drains and posts one batch (brief §2: "event batching with offline queue").
 * On failure the batch is requeued at the front — never dropped — so a
 * network blip costs a retry, not data; the caller (a timer or "app became
 * online" listener in `main/index.ts`) decides when to call this again.
 *
 * Returns the number of events actually flushed (0 on failure or an empty
 * queue), so a caller can decide whether to keep flushing immediately (there
 * may be more than one batch queued) or wait for the next tick.
 */
export async function flushOnce(deps: FlushDeps): Promise<number> {
  const batch = deps.queue.drain(BATCH_SIZE);
  if (batch.length === 0) return 0;
  try {
    await deps.postEvents(batch);
    return batch.length;
  } catch {
    deps.queue.requeue(batch);
    return 0;
  }
}

/** Keeps flushing batches until the queue is empty or one batch fails. */
export async function flushAll(deps: FlushDeps): Promise<number> {
  let total = 0;
  for (;;) {
    const flushed = await flushOnce(deps);
    total += flushed;
    if (flushed === 0) break;
  }
  return total;
}
