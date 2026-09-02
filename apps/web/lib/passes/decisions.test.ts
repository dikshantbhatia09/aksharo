import { describe, expect, it } from "vitest";

import type { Pass, PassItem } from "@montaj/edg";

import {
  decidedItemIds,
  decideItems,
  filterRows,
  itemsAtOrAbove,
  proposedItemIdsOfKind,
  reviewRows,
  summaryDurations,
} from "./decisions";

function cut(itemId: string, startMs: number, endMs: number, state: PassItem["state"], confidence?: number): PassItem {
  return {
    itemId,
    passId: "pass-1",
    kind: "cut",
    startMs,
    endMs,
    payload: {},
    state,
    ...(confidence === undefined ? {} : { confidence }),
  };
}

function pass(passId: string, items: PassItem[], createdAt?: string): Pass {
  return {
    passId,
    type: "autocut",
    engine: "autocut@2",
    params: {},
    status: "ready",
    items,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

describe("decideItems", () => {
  it("builds a DecideItems op with the given ids and state", () => {
    const op = decideItems(["a", "b"], "accepted", () => "op-1");
    expect(op).toEqual({ type: "DecideItems", opId: "op-1", itemIds: ["a", "b"], state: "accepted" });
  });
});

describe("reviewRows / filterRows", () => {
  const passes = [
    pass("p1", [cut("i1", 0, 1000, "proposed", 0.9), cut("i2", 1000, 2000, "accepted", 0.4)]),
    pass("p2", [cut("i3", 2000, 3000, "rejected", 0.95)]),
  ];

  it("flattens every pass's items", () => {
    expect(reviewRows(passes)).toHaveLength(3);
  });

  it("filters by kind, status and minConfidence", () => {
    const rows = reviewRows(passes);
    expect(filterRows(rows, { status: "proposed" }).map((r) => r.item.itemId)).toEqual(["i1"]);
    expect(filterRows(rows, { minConfidence: 0.9 }).map((r) => r.item.itemId).sort()).toEqual(["i1", "i3"]);
    expect(filterRows(rows, { kind: "cut", status: "rejected" }).map((r) => r.item.itemId)).toEqual(["i3"]);
  });
});

describe("itemsAtOrAbove / proposedItemIdsOfKind / decidedItemIds", () => {
  const rows = reviewRows([
    pass("p1", [
      cut("i1", 0, 1000, "proposed", 0.9),
      cut("i2", 1000, 2000, "proposed", 0.5),
      cut("i3", 2000, 3000, "accepted", 0.95),
    ]),
  ]);

  it("itemsAtOrAbove only counts still-proposed items over the threshold", () => {
    expect(itemsAtOrAbove(rows, 0.8)).toEqual(["i1"]);
  });

  it("proposedItemIdsOfKind returns every proposed item of one kind", () => {
    expect(proposedItemIdsOfKind(rows, "cut").sort()).toEqual(["i1", "i2"]);
  });

  it("decidedItemIds returns every non-proposed item", () => {
    expect(decidedItemIds(rows)).toEqual(["i3"]);
  });
});

describe("summaryDurations", () => {
  it("sums accepted cut durations only", () => {
    const rows = reviewRows([
      pass("p1", [
        cut("i1", 0, 1000, "accepted"),
        cut("i2", 2000, 2500, "proposed"),
        cut("i3", 5000, 6000, "accepted"),
      ]),
    ]);
    expect(summaryDurations(rows, 10_000)).toEqual({ removedMs: 2_000, resultingMs: 8_000 });
  });

  it("merges overlapping accepted cuts without double-counting", () => {
    const rows = reviewRows([
      pass("p1", [cut("i1", 1000, 3000, "accepted"), cut("i2", 2000, 4000, "accepted")]),
    ]);
    expect(summaryDurations(rows, 10_000)).toEqual({ removedMs: 3000, resultingMs: 7_000 });
  });
});
