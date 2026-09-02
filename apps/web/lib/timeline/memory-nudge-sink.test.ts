import { describe, expect, it, vi } from "vitest";

import { createMemoryNudgeSink, DEFAULT_MEMORY_NUDGE_DEBOUNCE_MS } from "./memory-nudge-sink";
import { segmentEdgeNudge, wordEdgeNudge } from "./nudge";

describe("createMemoryNudgeSink", () => {
  it("consent off: drops the nudge and never schedules a timer or calls record", () => {
    const record = vi.fn();
    const setTimeoutFn = vi.fn();
    const sink = createMemoryNudgeSink({ consented: () => false, record, setTimeoutFn });

    sink.record(segmentEdgeNudge("start", "seg1", 1000, 1200, () => 0));

    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("consent on: debounces a run of drags into one request, the last delta wins", () => {
    let scheduled: (() => void) | undefined;
    let cleared = 0;
    const setTimeoutFn = vi.fn((fn: () => void) => {
      scheduled = fn;
      return "handle";
    });
    const clearTimeoutFn = vi.fn(() => {
      cleared += 1;
    });
    const record = vi.fn();
    const sink = createMemoryNudgeSink({
      consented: () => true,
      record,
      setTimeoutFn,
      clearTimeoutFn,
    });

    sink.record(segmentEdgeNudge("start", "seg1", 1000, 1200, () => 0));
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(setTimeoutFn.mock.calls[0]?.[1]).toBe(DEFAULT_MEMORY_NUDGE_DEBOUNCE_MS);

    // A second drag before the debounce fires: the first timer is cleared, a
    // fresh one scheduled — only the final delta is ever sent.
    sink.record(wordEdgeNudge("end", "0:3", 2000, 1950, () => 0));
    expect(cleared).toBe(1);
    expect(setTimeoutFn).toHaveBeenCalledTimes(2);

    scheduled?.();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(-50);
  });

  it("re-checks consent on every nudge, not just once", () => {
    let granted = false;
    const record = vi.fn();
    const setTimeoutFn = vi.fn((fn: () => void) => {
      fn();
      return "handle";
    });
    const sink = createMemoryNudgeSink({ consented: () => granted, record, setTimeoutFn });

    sink.record(segmentEdgeNudge("start", "seg1", 0, 40, () => 0));
    expect(record).not.toHaveBeenCalled();

    granted = true;
    sink.record(segmentEdgeNudge("start", "seg1", 0, 60, () => 0));
    expect(record).toHaveBeenCalledWith(60);
  });
});
