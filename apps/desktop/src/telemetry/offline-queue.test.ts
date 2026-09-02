import { describe, expect, it } from "vitest";

import {
  createFileBackedQueue,
  createMemoryQueue,
  type QueuedTelemetryEvent,
  type QueueFileIO,
} from "./offline-queue.js";

function event(id: string): QueuedTelemetryEvent {
  return {
    eventId: id,
    kind: "app_launched",
    at: new Date().toISOString(),
    appVersion: "1.0.0",
    props: {},
  };
}

describe("createMemoryQueue", () => {
  it("enqueues and drains in FIFO order", () => {
    const queue = createMemoryQueue();
    queue.enqueue(event("a"));
    queue.enqueue(event("b"));
    queue.enqueue(event("c"));
    expect(queue.size()).toBe(3);

    const drained = queue.drain(2);
    expect(drained.map((e) => e.eventId)).toEqual(["a", "b"]);
    expect(queue.size()).toBe(1);
  });

  it("caps at maxQueued, dropping the oldest", () => {
    const queue = createMemoryQueue(3);
    queue.enqueue(event("a"));
    queue.enqueue(event("b"));
    queue.enqueue(event("c"));
    queue.enqueue(event("d"));
    expect(queue.size()).toBe(3);
    expect(queue.drain(10).map((e) => e.eventId)).toEqual(["b", "c", "d"]);
  });

  it("requeue puts events back at the front", () => {
    const queue = createMemoryQueue();
    queue.enqueue(event("a"));
    const drained = queue.drain(1);
    queue.enqueue(event("b"));
    queue.requeue(drained);
    expect(queue.drain(10).map((e) => e.eventId)).toEqual(["a", "b"]);
  });

  it("clear empties the queue", () => {
    const queue = createMemoryQueue();
    queue.enqueue(event("a"));
    queue.clear();
    expect(queue.size()).toBe(0);
  });
});

function memoryIO(): QueueFileIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readText: (path) => files.get(path),
    writeText: (path, content) => {
      files.set(path, content);
    },
  };
}

describe("createFileBackedQueue", () => {
  it("persists across a fresh queue instance against the same file", () => {
    const io = memoryIO();
    const first = createFileBackedQueue("/queue.json", io);
    first.enqueue(event("a"));
    first.enqueue(event("b"));

    const second = createFileBackedQueue("/queue.json", io);
    expect(second.size()).toBe(2);
    expect(second.drain(10).map((e) => e.eventId)).toEqual(["a", "b"]);
  });

  it("starts empty when the file does not exist yet", () => {
    const io = memoryIO();
    const queue = createFileBackedQueue("/missing.json", io);
    expect(queue.size()).toBe(0);
  });

  it("recovers from a corrupt file instead of throwing", () => {
    const io = memoryIO();
    io.files.set("/bad.json", "{not json");
    const queue = createFileBackedQueue("/bad.json", io);
    expect(queue.size()).toBe(0);
  });

  it("caps at maxQueued on disk too", () => {
    const io = memoryIO();
    const queue = createFileBackedQueue("/queue.json", io, 2);
    queue.enqueue(event("a"));
    queue.enqueue(event("b"));
    queue.enqueue(event("c"));
    expect(queue.drain(10).map((e) => e.eventId)).toEqual(["b", "c"]);
  });
});
