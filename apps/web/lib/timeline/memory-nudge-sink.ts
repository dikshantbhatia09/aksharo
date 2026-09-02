/**
 * B09b: the real `TimingNudgeSink` implementation `nudge.ts`'s doc-comment
 * says B09 had no consumer for. A17/A02d produce a `TimingNudge` per resolved
 * drag (segment-edge, word-edge); this turns a run of them into at most one
 * `POST /memory/hooks/timing-nudge` request, debounced so a user dragging the
 * same edge back and forth several times in quick succession sends one delta,
 * not one per pixel of adjustment.
 *
 * Framework-agnostic and dependency-injected on purpose — `consented()` and
 * `record()` are plain callbacks, so this is unit-testable with a fake clock
 * and no React, `EdgOpQueue`'s (`lib/edg/queue.ts`) own precedent for keeping
 * timing logic out of a component.
 */
import type { TimingNudge, TimingNudgeSink } from "./nudge";

export const DEFAULT_MEMORY_NUDGE_DEBOUNCE_MS = 400;

export interface MemoryNudgeSinkDeps {
  /** Re-read on every nudge — never cached — so a withdrawal takes effect immediately. */
  consented(): boolean;
  /** POSTs the (already debounced) delta to the timing-nudge hook. */
  record(deltaMs: number): void;
  debounceMs?: number;
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * A consent-gated, debounced sink over {@link MemoryNudgeSinkDeps}. When
 * `consented()` is false at the moment a nudge arrives, it is dropped
 * entirely — no timer is even scheduled, so a withheld consent produces zero
 * requests, not a request that is later suppressed.
 */
export function createMemoryNudgeSink(deps: MemoryNudgeSinkDeps): TimingNudgeSink {
  let handle: unknown = null;
  const schedule = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clear = deps.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  return {
    record(nudge: TimingNudge): void {
      if (!deps.consented()) return;
      if (handle !== null) clear(handle);
      const deltaMs = nudge.deltaMs;
      handle = schedule(() => {
        handle = null;
        deps.record(deltaMs);
      }, deps.debounceMs ?? DEFAULT_MEMORY_NUDGE_DEBOUNCE_MS);
    },
  };
}
