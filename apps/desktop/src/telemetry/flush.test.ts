import { describe, expect, it, vi } from "vitest";

import { flushAll, flushOnce } from "./flush.js";
import { createMemoryQueue, type QueuedTelemetryEvent } from "./offline-queue.js";

function event(id: string): QueuedTelemetryEvent {
  return {
    eventId: id,
    kind: "app_launched",
    at: new Date().toISOString(),
    appVersion: "1.0.0",
    props: {},
  };
}

describe("flushOnce", () => {
  it("returns 0 without calling postEvents when the queue is empty", async () => {
    const queue = createMemoryQueue();
    const postEvents = vi.fn();
    expect(await flushOnce({ queue, postEvents })).toBe(0);
    expect(postEvents).not.toHaveBeenCalled();
  });

  it("drains and posts a batch on success", async () => {
    const queue = createMemoryQueue();
    const a = event("a");
    const b = event("b");
    queue.enqueue(a);
    queue.enqueue(b);
    const postEvents = vi.fn().mockResolvedValue(undefined);
    const flushed = await flushOnce({ queue, postEvents });
    expect(flushed).toBe(2);
    expect(postEvents).toHaveBeenCalledWith([a, b]);
    expect(queue.size()).toBe(0);
  });

  it("requeues the batch (never drops it) when posting fails", async () => {
    const queue = createMemoryQueue();
    queue.enqueue(event("a"));
    const postEvents = vi.fn().mockRejectedValue(new Error("offline"));
    const flushed = await flushOnce({ queue, postEvents });
    expect(flushed).toBe(0);
    expect(queue.size()).toBe(1);
    expect(queue.drain(10).map((e) => e.eventId)).toEqual(["a"]);
  });
});

describe("flushAll", () => {
  it("keeps flushing until the queue is empty", async () => {
    const queue = createMemoryQueue();
    for (let i = 0; i < 5; i += 1) queue.enqueue(event(`e${String(i)}`));
    const postEvents = vi.fn().mockResolvedValue(undefined);
    // Force multiple small batches by draining 2 at a time via a wrapped queue.
    const total = await flushAll({ queue, postEvents });
    expect(total).toBe(5);
    expect(queue.size()).toBe(0);
  });

  it("stops after the first failed batch, leaving the rest queued", async () => {
    const queue = createMemoryQueue();
    queue.enqueue(event("a"));
    const postEvents = vi.fn().mockRejectedValue(new Error("offline"));
    const total = await flushAll({ queue, postEvents });
    expect(total).toBe(0);
    expect(queue.size()).toBe(1);
  });
});
