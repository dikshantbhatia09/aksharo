import { describe, expect, it } from "vitest";

import { buildTimeMap, cutEdit } from "@montaj/timemap";

import {
  displayDurationMs,
  isCutAway,
  outputModeAvailable,
  toDisplayMs,
  toSourceMs,
} from "./output-clock";

describe("without a time map (no accepted cuts)", () => {
  it("source and output are the same clock", () => {
    expect(toDisplayMs(5000, "output", undefined)).toBe(5000);
    expect(toSourceMs(5000, "output", undefined)).toBe(5000);
    expect(displayDurationMs(60_000, "output", undefined)).toBe(60_000);
    expect(isCutAway(5000, undefined)).toBe(false);
    expect(outputModeAvailable(undefined)).toBe(false);
  });
});

describe("with accepted cuts", () => {
  const map = buildTimeMap({
    sourceDurationMs: 10_000,
    edits: [cutEdit(2000, 3000), cutEdit(6000, 6500)],
  });

  it("source mode always passes ms through unchanged", () => {
    expect(toDisplayMs(2500, "source", map)).toBe(2500);
    expect(toSourceMs(2500, "source", map)).toBe(2500);
  });

  it("output mode maps a retained instant forward", () => {
    expect(toDisplayMs(3500, "output", map)).toBe(2500);
  });

  it("output mode collapses a cut-away instant onto the splice", () => {
    const display = toDisplayMs(2500, "output", map); // inside the first cut
    expect(display).toBe(2000);
  });

  it("scrubbing an output position always resolves to a source ms for the proxy", () => {
    expect(toSourceMs(2000, "output", map)).toBe(3000); // the splice -> frame after the cut
  });

  it("reports the output duration, shorter than the source by the cuts", () => {
    expect(displayDurationMs(10_000, "output", map)).toBe(map.outputDurationMs);
    expect(map.outputDurationMs).toBe(8500);
  });

  it("flags cut-away source instants for the ghosted ruler", () => {
    expect(isCutAway(2500, map)).toBe(true);
    expect(isCutAway(500, map)).toBe(false);
  });

  it("becomes available once at least one cut exists", () => {
    expect(outputModeAvailable(map)).toBe(true);
    const empty = buildTimeMap({ sourceDurationMs: 10_000, edits: [] });
    expect(outputModeAvailable(empty)).toBe(false);
  });
});
