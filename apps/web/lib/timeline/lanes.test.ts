import { describe, expect, it } from "vitest";

import type { PassItem } from "@montaj/edg";

import { buildLanes, laneItemStrokeStyle, laneStateColor } from "./lanes";

function cutItem(overrides: Partial<PassItem> = {}): PassItem {
  return {
    itemId: "01ITEM0000000000000000001",
    passId: "01PASS00000000000000000001",
    kind: "cut",
    startMs: 1000,
    endMs: 2000,
    state: "proposed",
    payload: {},
    ...overrides,
  } as PassItem;
}

describe("buildLanes", () => {
  it("groups cut/zoom/reframe/sfx/music into four separate lane rows, in order", () => {
    const items: PassItem[] = [
      cutItem(),
      { ...cutItem(), itemId: "i2", kind: "zoom", payload: {} } as PassItem,
      { ...cutItem(), itemId: "i3", kind: "reframe", payload: {} } as PassItem,
      { ...cutItem(), itemId: "i4", kind: "sfx", payload: {} } as PassItem,
    ];
    const lanes = buildLanes(items);
    expect(lanes.map((l) => l.kind)).toEqual(["cuts", "zoom", "reframe", "audio"]);
    expect(lanes[0]!.items).toHaveLength(1);
    expect(lanes[1]!.items).toHaveLength(1);
    expect(lanes[2]!.items).toHaveLength(1);
    expect(lanes[3]!.items).toHaveLength(1);
  });

  it("sorts items within a lane by startMs", () => {
    const items: PassItem[] = [
      cutItem({ itemId: "later", startMs: 5000, endMs: 6000 }),
      cutItem({ itemId: "earlier", startMs: 100, endMs: 200 }),
    ];
    const lanes = buildLanes(items);
    expect(lanes[0]!.items.map((i) => i.itemId)).toEqual(["earlier", "later"]);
  });

  it("ignores unknown item kinds (title has no lane yet) without throwing", () => {
    const items: PassItem[] = [{ ...cutItem(), kind: "title", payload: {} } as PassItem];
    expect(() => buildLanes(items)).not.toThrow();
    const lanes = buildLanes(items);
    expect(lanes.every((l) => l.items.length === 0)).toBe(true);
  });

  it("always returns exactly the four lanes, even for an empty document", () => {
    expect(buildLanes([]).map((l) => l.kind)).toEqual(["cuts", "zoom", "reframe", "audio"]);
  });
});

describe("laneStateColor", () => {
  it("returns a distinct colour per state", () => {
    const states = ["proposed", "accepted", "modified", "rejected"] as const;
    const colors = new Set(states.map((s) => laneStateColor(s)));
    expect(colors.size).toBe(4);
  });
});

describe("laneItemStrokeStyle", () => {
  it("dashes proposed items", () => {
    expect(laneItemStrokeStyle("proposed").dash.length).toBeGreaterThan(0);
  });

  it("strikes through and dims accepted items", () => {
    const style = laneItemStrokeStyle("accepted");
    expect(style.struckThrough).toBe(true);
    expect(style.dash).toEqual([]);
  });

  it("draws rejected items solid but at low alpha", () => {
    const style = laneItemStrokeStyle("rejected");
    expect(style.dash).toEqual([]);
    expect(style.struckThrough).toBe(false);
    expect(style.alpha).toBeLessThan(laneItemStrokeStyle("proposed").alpha);
  });
});
