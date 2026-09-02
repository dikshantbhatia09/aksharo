import { describe, expect, it } from "vitest";

import { noopNudgeSink, segmentEdgeNudge, type TimingNudgeSink, wordEdgeNudge } from "./nudge";

describe("noopNudgeSink", () => {
  it("never throws and records nothing observable", () => {
    expect(() => noopNudgeSink.record(segmentEdgeNudge("start", "seg1", 100, 200))).not.toThrow();
  });
});

describe("segmentEdgeNudge", () => {
  it("computes a signed delta and carries the clock", () => {
    const now = () => 123456;
    const nudge = segmentEdgeNudge("end", "seg1", 2000, 2500, now);
    expect(nudge).toEqual({
      kind: "segment-end",
      targetId: "seg1",
      deltaMs: 500,
      fromMs: 2000,
      toMs: 2500,
      atEpochMs: 123456,
    });
  });

  it("a negative drag produces a negative delta", () => {
    const nudge = segmentEdgeNudge("start", "seg1", 2000, 1800, () => 0);
    expect(nudge.deltaMs).toBe(-200);
  });
});

describe("wordEdgeNudge", () => {
  it("computes a signed delta and carries the clock, at the word grain", () => {
    const now = () => 123456;
    const nudge = wordEdgeNudge("end", "0:3", 950, 940, now);
    expect(nudge).toEqual({
      kind: "word-end",
      targetId: "0:3",
      deltaMs: -10,
      fromMs: 950,
      toMs: 940,
      atEpochMs: 123456,
    });
  });

  it("start edge carries the word-start kind", () => {
    const nudge = wordEdgeNudge("start", "0:3", 500, 460, () => 0);
    expect(nudge.kind).toBe("word-start");
    expect(nudge.deltaMs).toBe(-40);
  });
});

describe("a real sink receives what a no-op sink discards", () => {
  it("is a drop-in replacement (interface parity)", () => {
    const received: unknown[] = [];
    const sink: TimingNudgeSink = { record: (n) => received.push(n) };
    sink.record(segmentEdgeNudge("start", "seg1", 0, 40, () => 1));
    expect(received).toHaveLength(1);
  });
});
