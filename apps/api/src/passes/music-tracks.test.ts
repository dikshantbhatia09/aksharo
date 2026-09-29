import { describe, expect, it } from "vitest";

import {
  acceptedMusicAssetIds,
  acceptedWorkspaceMusicAssetIds,
  resolveMusicTracks,
  type MusicCarryingItem,
} from "./music-tracks.js";

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

describe("a workspace's own music (2026-10-04)", () => {
  const own = musicItem({
    itemId: "item-own",
    payload: { ...musicItem().payload, assetId: "track-1", packId: "workspace" },
  });
  const catalogue = musicItem();

  it("asks the catalogue for catalogue beds only, and the workspace for its own", () => {
    expect(acceptedMusicAssetIds([own, catalogue])).toEqual(["asset-1"]);
    expect(acceptedWorkspaceMusicAssetIds([own, catalogue])).toEqual(["track-1"]);
    expect(acceptedWorkspaceMusicAssetIds([{ ...own, state: "rejected" }])).toEqual([]);
  });

  it("resolves each bed only where it belongs, so neither stands in for the other", () => {
    const tracks = resolveMusicTracks(
      [own, catalogue],
      // A catalogue row with the workspace track's id must not serve it...
      new Map([
        ["asset-1", "packs/fixture-pack-01/asset-1.wav"],
        ["track-1", "packs/elsewhere/track-1.wav"],
      ]),
      // ...nor a workspace row the catalogue bed's.
      new Map([
        ["track-1", "ws/W/brand/track-1.mp3"],
        ["asset-1", "ws/W/brand/asset-1.mp3"],
      ]),
    );
    expect(tracks.map((track) => [track.assetId, track.storageKey])).toEqual([
      ["track-1", "ws/W/brand/track-1.mp3"],
      ["asset-1", "packs/fixture-pack-01/asset-1.wav"],
    ]);
    // Without its track, a workspace bed is left out.
    expect(resolveMusicTracks([own], new Map([["track-1", "packs/x.wav"]]))).toEqual([]);
  });
});
