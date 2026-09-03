import { describe, expect, it, vi } from "vitest";

import { resolveKeyframeTracks, type KeyframeCarryingItem } from "./keyframe-tracks.js";

function item(overrides: Partial<KeyframeCarryingItem> = {}): KeyframeCarryingItem {
  return {
    itemId: "01ITEM0000000000000000000",
    kind: "zoom",
    state: "accepted",
    startMs: 1_000,
    payload: {},
    ...overrides,
  };
}

describe("resolveKeyframeTracks", () => {
  it("carries an accepted item's inline keyframes through unchanged", async () => {
    const store = { get: vi.fn() };
    const tracks = await resolveKeyframeTracks([item({ payload: { keyframes: "QUJD" } })], store);
    expect(tracks).toEqual([
      { itemId: "01ITEM0000000000000000000", kind: "zoom", itemStartMs: 1_000, packed: "QUJD" },
    ]);
    expect(store.get).not.toHaveBeenCalled();
  });

  it("fetches a keyframesRef from derived storage and base64-encodes it", async () => {
    const bytes = Buffer.from("hello-keyframes");
    const store = { get: vi.fn().mockResolvedValue(bytes) };
    const tracks = await resolveKeyframeTracks(
      [item({ kind: "reframe", keyframesRef: "ws/w1/passes/p1/i1.mkf" })],
      store,
    );
    expect(store.get).toHaveBeenCalledWith("ws/w1/passes/p1/i1.mkf");
    expect(tracks).toEqual([
      {
        itemId: "01ITEM0000000000000000000",
        kind: "reframe",
        itemStartMs: 1_000,
        packed: bytes.toString("base64"),
      },
    ]);
  });

  it("reads a payload-nested keyframesRef the same way", async () => {
    const bytes = Buffer.from("nested-ref");
    const store = { get: vi.fn().mockResolvedValue(bytes) };
    const tracks = await resolveKeyframeTracks(
      [item({ payload: { keyframesRef: "ws/w1/passes/p1/i1.mkf" } })],
      store,
    );
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.packed).toBe(bytes.toString("base64"));
  });

  it("ignores proposed and rejected items, and non-zoom/reframe kinds", async () => {
    const store = { get: vi.fn() };
    const tracks = await resolveKeyframeTracks(
      [
        item({ state: "proposed", payload: { keyframes: "QQ==" } }),
        item({ state: "rejected", payload: { keyframes: "QQ==" } }),
        item({ kind: "cut", payload: {} }),
      ],
      store,
    );
    expect(tracks).toEqual([]);
  });

  it("skips an accepted item with neither an inline curve nor a ref", async () => {
    const store = { get: vi.fn() };
    const tracks = await resolveKeyframeTracks([item({ payload: {} })], store);
    expect(tracks).toEqual([]);
    expect(store.get).not.toHaveBeenCalled();
  });
});
