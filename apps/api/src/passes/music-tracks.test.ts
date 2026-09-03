import { describe, expect, it } from "vitest";

import { acceptedMusicAssetIds, resolveMusicTracks, type MusicCarryingItem } from "./music-tracks.js";

function musicItem(overrides: Partial<MusicCarryingItem> = {}): MusicCarryingItem {
  return {
    itemId: "item-1",
    kind: "music",
    state: "accepted",
    startMs: 0,
    endMs: 20_000,
    payload: {
      assetId: "asset-1",
      packId: "fixture-pack-01",
      startMs: 0,
      durationMs: 20_000,
      gainDb: -18,
      loopPolicy: "loop",
      bedDuck: { depthDb: -12, attackMs: 150, releaseMs: 150 },
      licenceSnapshot: { provider: "owned" },
      mood: ["calm"],
      bpm: 92,
    },
    ...overrides,
  };
}

describe("resolveMusicTracks", () => {
  it("resolves an accepted music item into a MusicTrack", () => {
    const tracks = resolveMusicTracks(
      [musicItem()],
      new Map([["asset-1", "packs/fixture-pack-01/asset-1.wav"]]),
    );
    expect(tracks).toEqual([
      {
        itemId: "item-1",
        startMs: 0,
        endMs: 20_000,
        assetId: "asset-1",
        packId: "fixture-pack-01",
        storageKey: "packs/fixture-pack-01/asset-1.wav",
        gainDb: -18,
        loopPolicy: "loop",
        bedDuck: { depthDb: -12, attackMs: 150, releaseMs: 150 },
        mood: ["calm"],
        bpm: 92,
      },
    ]);
  });

  it("skips a proposed or rejected item — only accepted items render", () => {
    const tracks = resolveMusicTracks(
      [musicItem({ state: "proposed" }), musicItem({ state: "rejected" })],
      new Map([["asset-1", "packs/fixture-pack-01/asset-1.wav"]]),
    );
    expect(tracks).toEqual([]);
  });

  it("skips a non-music item", () => {
    const tracks = resolveMusicTracks(
      [musicItem({ kind: "sfx" })],
      new Map([["asset-1", "packs/fixture-pack-01/asset-1.wav"]]),
    );
    expect(tracks).toEqual([]);
  });

  it("skips an item whose asset has no storage key (deleted from the catalogue)", () => {
    const tracks = resolveMusicTracks([musicItem()], new Map());
    expect(tracks).toEqual([]);
  });

  it("defaults gainDb/loopPolicy/bedDuck/mood/bpm when the payload lacks them", () => {
    const tracks = resolveMusicTracks(
      [
        musicItem({
          payload: { assetId: "asset-1", packId: "fixture-pack-01" },
        }),
      ],
      new Map([["asset-1", "packs/fixture-pack-01/asset-1.wav"]]),
    );
    expect(tracks).toEqual([
      {
        itemId: "item-1",
        startMs: 0,
        endMs: 20_000,
        assetId: "asset-1",
        packId: "fixture-pack-01",
        storageKey: "packs/fixture-pack-01/asset-1.wav",
        gainDb: 0,
        loopPolicy: "none",
        bedDuck: null,
        mood: [],
      },
    ]);
  });
});

describe("acceptedMusicAssetIds", () => {
  it("collects every distinct accepted music assetId", () => {
    const ids = acceptedMusicAssetIds([
      musicItem({ itemId: "a", payload: { ...musicItem().payload, assetId: "asset-1" } }),
      musicItem({ itemId: "b", payload: { ...musicItem().payload, assetId: "asset-2" } }),
      musicItem({ itemId: "c", payload: { ...musicItem().payload, assetId: "asset-1" } }),
      musicItem({ itemId: "d", state: "proposed" }),
      musicItem({ itemId: "e", kind: "sfx" }),
    ]);
    expect(ids.sort()).toEqual(["asset-1", "asset-2"]);
  });
});
