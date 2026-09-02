/**
 * The offline queue behind `POST /telemetry/events` batching (brief §2).
 *
 * Pure and injectable: the main process wires this to a JSON file under
 * Electron's `userData` directory (`createFileBackedQueue` below), and the
 * tests wire it to an in-memory array — so the batching/cap/drain logic is
 * unit-testable without a real Electron runtime (this package's coverage
 * threshold explicitly carves out "main/preload wiring" for the Playwright
 * smoke suite instead; this file is the "pure allowlist/logic" half).
 *
 * The queue only ever grows while telemetry consent is granted — gating
 * happens one layer up (whoever calls `enqueue` checks consent first), but
 * the cap here is what stops an offline stretch from growing the file
 * without bound.
 */

export interface QueuedTelemetryEvent {
  readonly eventId: string;
  readonly kind: string;
  readonly at: string;
  readonly appVersion: string;
  readonly props: Record<string, unknown>;
}

export interface TelemetryOfflineQueue {
  enqueue(event: QueuedTelemetryEvent): void;
  /** Removes and returns up to `limit` events, oldest first. */
  drain(limit: number): QueuedTelemetryEvent[];
  /** Puts events back at the front (a flush that failed after dequeuing). */
  requeue(events: readonly QueuedTelemetryEvent[]): void;
  size(): number;
  clear(): void;
}

const DEFAULT_MAX_QUEUED = 2_000;

/**
 * An in-memory queue with a hard cap: past `maxQueued`, the oldest events are
 * dropped to make room for the newest — a crash-loop must not turn into an
 * unbounded backlog, and the newest events (closer to whatever just went
 * wrong) are the more useful ones to keep.
 */
export function createMemoryQueue(maxQueued: number = DEFAULT_MAX_QUEUED): TelemetryOfflineQueue {
  let items: QueuedTelemetryEvent[] = [];

  return {
    enqueue(event) {
      items.push(event);
      if (items.length > maxQueued) {
        items = items.slice(items.length - maxQueued);
      }
    },
    drain(limit) {
      const taken = items.slice(0, limit);
      items = items.slice(taken.length);
      return taken;
    },
    requeue(events) {
      items = [...events, ...items];
      if (items.length > maxQueued) {
        items = items.slice(0, maxQueued);
      }
    },
    size() {
      return items.length;
    },
    clear() {
      items = [];
    },
  };
}

export interface QueueFileIO {
  readText(path: string): string | undefined;
  writeText(path: string, content: string): void;
}

/**
 * A queue backed by a single JSON file, so it survives an app restart while
 * offline. `io` is injected (real `fs` in the main process, an in-memory
 * stand-in in tests) for the same reason every other file here takes its
 * side effects as parameters.
 */
export function createFileBackedQueue(
  path: string,
  io: QueueFileIO,
  maxQueued: number = DEFAULT_MAX_QUEUED,
): TelemetryOfflineQueue {
  function load(): QueuedTelemetryEvent[] {
    const raw = io.readText(path);
    if (raw === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as QueuedTelemetryEvent[]) : [];
    } catch {
      return [];
    }
  }

  function save(items: QueuedTelemetryEvent[]): void {
    io.writeText(path, JSON.stringify(items));
  }

  return {
    enqueue(event) {
      let items = load();
      items.push(event);
      if (items.length > maxQueued) items = items.slice(items.length - maxQueued);
      save(items);
    },
    drain(limit) {
      const items = load();
      const taken = items.slice(0, limit);
      save(items.slice(taken.length));
      return taken;
    },
    requeue(events) {
      let items = [...events, ...load()];
      if (items.length > maxQueued) items = items.slice(0, maxQueued);
      save(items);
    },
    size() {
      return load().length;
    },
    clear() {
      save([]);
    },
  };
}
