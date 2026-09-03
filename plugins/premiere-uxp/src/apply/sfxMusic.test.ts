import { describe, expect, it } from "vitest";

import type { ApplyPlanItem, AudioClipOp } from "@montaj/shared-apply";

import { applyAcceptedSfxMusic, buildDuckKeyframes, buildGainKeyframes } from "./sfxMusic.js";
import { MockPremiereHost } from "../host/premiere.js";

const FPS = 25;

function sfxItem(overrides: Partial<ApplyPlanItem> = {}): ApplyPlanItem {
  return {
    itemId: "sfx-1",
    passId: "pass-1",
    kind: "sfx",
    startMs: 1000,
    endMs: 1400,
    state: "accepted",
    payload: {
      assetId: "asset-1",
      packId: "pack-1",
      startMs: 1000,
      durationMs: 400,
      gainDb: -4,
      fadeInMs: 40,
      fadeOutMs: 40,
      duck: { depthDb: -8, attackMs: 20, releaseMs: 100 },
      licenceSnapshot: { allowsRawFileDelivery: true, surface: ["panel"] },
      cueReason: "impact",
    },
    ...overrides,
  };
}

function musicItem(overrides: Partial<ApplyPlanItem> = {}): ApplyPlanItem {
  return {
    itemId: "music-1",
    passId: "pass-2",
    kind: "music",
    startMs: 0,
    endMs: 4000,
    state: "accepted",
    payload: {
      assetId: "asset-partner-1",
      packId: "pack-partner",
      startMs: 0,
      durationMs: 4000,
      gainDb: -12,
      loopPolicy: "loop",
      bedDuck: null,
      licenceSnapshot: { allowsRawFileDelivery: false, surface: ["cloud_render"] },
      mood: "calm",
      bpm: 100,
    },
    ...overrides,
  };
}

describe("buildGainKeyframes", () => {
  it("ramps in from silence over fadeInMs and back down over fadeOutMs", () => {
    const op: AudioClipOp = {
      op: "audioClip",
      itemId: "s1",
      kind: "sfx",
      assetId: "a1",
      packId: "p1",
      startMs: 1000,
      durationMs: 400,
      gainDb: -4,
      fade: { fadeInMs: 40, fadeOutMs: 40 },
      duck: null,
      loopPolicy: null,
      trackName: "Aksharo SFX",
    };
    const keyframes = buildGainKeyframes(op, FPS);
    expect(keyframes).toEqual([
      { atFrames: 25, gainDb: -60 },
      { atFrames: 26, gainDb: -4 },
      { atFrames: 34, gainDb: -4 },
      { atFrames: 35, gainDb: -60 },
    ]);
  });

  it("emits a single flat keyframe when there is no fade at all", () => {
    const op: AudioClipOp = {
      op: "audioClip",
      itemId: "m1",
      kind: "music",
      assetId: "a2",
      packId: "p2",
      startMs: 0,
      durationMs: 4000,
      gainDb: -12,
      fade: { fadeInMs: 0, fadeOutMs: 0 },
      duck: null,
      loopPolicy: "loop",
      trackName: "Aksharo Music",
    };
    expect(buildGainKeyframes(op, FPS)).toEqual([{ atFrames: 0, gainDb: -12 }]);
  });
});

describe("buildDuckKeyframes", () => {
  it("dips to depthDb between attack and release", () => {
    const op: AudioClipOp = {
      op: "audioClip",
      itemId: "s1",
      kind: "sfx",
      assetId: "a1",
      packId: "p1",
      startMs: 1000,
      durationMs: 400,
      gainDb: -4,
      fade: { fadeInMs: 0, fadeOutMs: 0 },
      duck: { depthDb: -8, attackMs: 20, releaseMs: 100 },
      loopPolicy: null,
      trackName: "Aksharo SFX",
    };
    expect(buildDuckKeyframes(op, FPS)).toEqual([
      { atFrames: 25, gainDb: 0 },
      { atFrames: 26, gainDb: -8 },
      { atFrames: 32, gainDb: -8 },
      { atFrames: 35, gainDb: 0 },
    ]);
  });

  it("returns undefined when the item carries no duck spec", () => {
    const op: AudioClipOp = {
      op: "audioClip",
      itemId: "m1",
      kind: "music",
      assetId: "a2",
      packId: "p2",
      startMs: 0,
      durationMs: 4000,
      gainDb: -12,
      fade: { fadeInMs: 0, fadeOutMs: 0 },
      duck: null,
      loopPolicy: "loop",
      trackName: "Aksharo Music",
    };
    expect(buildDuckKeyframes(op, FPS)).toBeUndefined();
  });
});

describe("applyAcceptedSfxMusic", () => {
  it("places an owned+panel-licensed sfx clip on a dedicated track with gain and duck keyframes", async () => {
    const host = new MockPremiereHost();
    const result = await applyAcceptedSfxMusic(host, {
      projectId: "proj-1",
      items: [sfxItem()],
      assetLocalPaths: new Map([["asset-1", "/tmp/asset-1.wav"]]),
      fps: FPS,
      dialogueTrackItemId: "dialogue-track-item-1",
    });

    expect(result.refusals).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.placed).toHaveLength(1);
    const placement = result.placed[0];
    if (!placement) throw new Error("expected one placed clip");
    expect(placement).toMatchObject({ itemId: "sfx-1", kind: "sfx" });

    const track = await host.ensureTrack({ kind: "audio", name: "Aksharo SFX" });
    expect(track.reused).toBe(true); // already created by applyAcceptedSfxMusic

    expect(host.getGainKeyframesFor(placement.trackItemId)).toBeDefined();
    expect(host.getGainKeyframesFor("dialogue-track-item-1")).toBeDefined();

    const metadata = await host.getItemMetadata(placement.trackItemId);
    expect(metadata).toEqual({ aksharo: { projectId: "proj-1", itemId: "sfx-1", rev: 0 } });
  });

  it("refuses a partner-catalogue music item without placing anything", async () => {
    const host = new MockPremiereHost();
    const result = await applyAcceptedSfxMusic(host, {
      projectId: "proj-1",
      items: [musicItem()],
      assetLocalPaths: new Map([["asset-partner-1", "/tmp/asset-partner-1.wav"]]),
      fps: FPS,
    });
    expect(result.placed).toEqual([]);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({ itemId: "music-1", kind: "music" });
  });

  it("skips an accepted item whose asset has not been downloaded yet", async () => {
    const host = new MockPremiereHost();
    const result = await applyAcceptedSfxMusic(host, {
      projectId: "proj-1",
      items: [sfxItem()],
      assetLocalPaths: new Map(),
      fps: FPS,
    });
    expect(result.placed).toEqual([]);
    expect(result.skipped).toEqual([{ itemId: "sfx-1", reason: "asset-not-downloaded" }]);
  });

  it("reuses the same dedicated track across two sfx items instead of creating a duplicate", async () => {
    const host = new MockPremiereHost();
    const items = [
      sfxItem({ itemId: "sfx-a" }),
      sfxItem({ itemId: "sfx-b", startMs: 2000, endMs: 2400 }),
    ];
    const result = await applyAcceptedSfxMusic(host, {
      projectId: "proj-1",
      items,
      assetLocalPaths: new Map([["asset-1", "/tmp/asset-1.wav"]]),
      fps: FPS,
    });
    expect(result.placed).toHaveLength(2);
    const track = await host.ensureTrack({ kind: "audio", name: "Aksharo SFX" });
    expect(track.reused).toBe(true);
  });

  it("ignores non-accepted sfx/music items and non-sfx/music kinds", async () => {
    const host = new MockPremiereHost();
    const result = await applyAcceptedSfxMusic(host, {
      projectId: "proj-1",
      items: [
        sfxItem({ state: "proposed" }),
        {
          itemId: "cut-1",
          passId: "p1",
          kind: "cut",
          startMs: 0,
          endMs: 10,
          state: "accepted",
          payload: {},
        },
      ],
      assetLocalPaths: new Map([["asset-1", "/tmp/asset-1.wav"]]),
      fps: FPS,
    });
    expect(result.placed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.refusals).toEqual([]);
  });
});
