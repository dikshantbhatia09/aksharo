import { describe, expect, it } from "vitest";

import type { PassItem } from "@montaj/edg";

import { speedEdit } from "./edits.js";
import { cutsFromItems, fromAcceptedItems } from "./pass-items.js";

import type { PassItemTimes } from "./pass-items.js";

const item = (
  kind: PassItemTimes["kind"],
  state: PassItemTimes["state"],
  startMs: number,
  endMs: number,
): PassItemTimes => ({ kind, state, startMs, endMs });

describe("cutsFromItems", () => {
  it("takes accepted cuts and nothing else", () => {
    expect(
      cutsFromItems([
        item("cut", "accepted", 1000, 2000),
        item("cut", "proposed", 3000, 4000),
        item("cut", "rejected", 5000, 6000),
        item("cut", "modified", 7000, 8000),
        item("zoom", "accepted", 100, 200),
        item("reframe", "accepted", 100, 200),
        item("sfx", "accepted", 100, 200),
        item("music", "accepted", 100, 200),
        item("title", "accepted", 100, 200),
      ]),
    ).toEqual([{ kind: "cut", startMs: 1000, endMs: 2000 }]);
  });

  it("can be asked to include other states", () => {
    expect(
      cutsFromItems(
        [item("cut", "accepted", 0, 1), item("cut", "modified", 2, 3)],
        ["accepted", "modified"],
      ),
    ).toHaveLength(2);
  });

  it("returns nothing for an empty list", () => {
    expect(cutsFromItems([])).toEqual([]);
  });
});

describe("fromAcceptedItems", () => {
  it("builds a map whose output is the source minus the accepted cuts", () => {
    const map = fromAcceptedItems(
      [
        item("cut", "accepted", 1000, 2000),
        item("cut", "accepted", 5000, 5500),
        item("cut", "proposed", 8000, 9000),
        item("zoom", "accepted", 0, 10_000),
      ],
      { sourceDurationMs: 10_000 },
    );
    expect(map.outputDurationMs).toBe(10_000 - 1000 - 500);
    expect(map.cuts).toHaveLength(2);
  });

  it("merges cuts two passes proposed over the same silence", () => {
    const map = fromAcceptedItems(
      [item("cut", "accepted", 1000, 3000), item("cut", "accepted", 2000, 4000)],
      { sourceDurationMs: 10_000 },
    );
    expect(map.cuts).toEqual([{ kind: "cut", startMs: 1000, endMs: 4000 }]);
    expect(map.outputDurationMs).toBe(7000);
  });

  it("applies extra edits alongside the cuts and snaps to frames", () => {
    const map = fromAcceptedItems([item("cut", "accepted", 1010, 2030)], {
      sourceDurationMs: 10_000,
      fps: 25,
      snapCutsToFrames: true,
      extraEdits: [speedEdit(5000, 6000, 2)],
    });
    expect(map.cuts).toEqual([{ kind: "cut", startMs: 1000, endMs: 2040 }]);
    expect(map.speeds).toHaveLength(1);
  });

  it("accepts a full PassItem from @montaj/edg", () => {
    const full: PassItem = {
      itemId: "01JBZ9F8Q0000000000000000A",
      passId: "01JBZ9F8Q0000000000000000B",
      kind: "cut",
      startMs: 1000,
      endMs: 2000,
      payload: {},
      state: "accepted",
    };
    expect(fromAcceptedItems([full], { sourceDurationMs: 5000 }).outputDurationMs).toBe(4000);
  });
});
