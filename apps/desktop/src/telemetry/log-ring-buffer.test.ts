import { describe, expect, it } from "vitest";

import { createLogRingBuffer } from "./log-ring-buffer.js";

describe("createLogRingBuffer", () => {
  it("returns pushed lines in order", () => {
    const buffer = createLogRingBuffer();
    buffer.push("a");
    buffer.push("b");
    expect(buffer.lines()).toEqual(["a", "b"]);
  });

  it("drops the oldest line past capacity", () => {
    const buffer = createLogRingBuffer(2);
    buffer.push("a");
    buffer.push("b");
    buffer.push("c");
    expect(buffer.lines()).toEqual(["b", "c"]);
  });

  it("lines() returns a snapshot, not a live view", () => {
    const buffer = createLogRingBuffer();
    buffer.push("a");
    const snapshot = buffer.lines();
    buffer.push("b");
    expect(snapshot).toEqual(["a"]);
  });
});
