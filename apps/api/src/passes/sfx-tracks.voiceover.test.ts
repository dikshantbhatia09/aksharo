import { describe, expect, it } from "vitest";

import { stableOverlayId, voiceoverPass } from "@montaj/edg";

import { acceptedSfxAssetIds, acceptedVoiceoverAssetIds, resolveSfxTracks } from "./sfx-tracks.js";

/**
 * A voice-over hook's cue (2026-10-01) resolves only among the workspace's
 * voice-overs, a catalogue cue only in the catalogue, and the voice-over's
 * `playThrough` and `dialogueDuck` ride through to the manifest track.
 */
const VOICEOVER = "01JCDVC0000000000000000000";
const CATALOGUE = "01JCAT0000000000000000000A";

const voice = voiceoverPass({
  voiceoverId: VOICEOVER,
  startMs: 400,
  durationMs: 2_000,
  text: "Wait for it",
  language: "en-IN",
  speaker: "priya",
  passId: stableOverlayId("v:pass"),
  itemId: stableOverlayId("v:item"),
});
if (voice === undefined) throw new Error("voiceoverPass refused the fixture");
const voiceItem = voice.items[0] as unknown as Parameters<typeof resolveSfxTracks>[0][number];
const catalogueItem = {
  ...voiceItem,
  itemId: stableOverlayId("c:item"),
  payload: {
    ...voiceItem.payload,
    assetId: CATALOGUE,
    packId: "impacts",
    playThrough: undefined,
    dialogueDuck: undefined,
  },
} as Parameters<typeof resolveSfxTracks>[0][number];

describe("sfx tracks with a voice-over (2026-10-01)", () => {
  it("names each kind's assets apart", () => {
    expect(acceptedSfxAssetIds([voiceItem, catalogueItem])).toEqual([CATALOGUE]);
    expect(acceptedVoiceoverAssetIds([voiceItem, catalogueItem])).toEqual([VOICEOVER]);
  });

  it("resolves a voice-over only among the voice-overs, with its play-through and duck", () => {
    const tracks = resolveSfxTracks(
      [voiceItem, catalogueItem],
      new Map([
        [CATALOGUE, "packs/impacts/a.wav"],
        // The same id in the catalogue must never stand in for the voice-over.
        [VOICEOVER, "packs/evil/b.wav"],
      ]),
      new Map([[VOICEOVER, "ws/x/voiceovers/hook.wav"]]),
    );
    const spoken = tracks.find((track) => track.assetId === VOICEOVER);
    expect(spoken?.storageKey).toBe("ws/x/voiceovers/hook.wav");
    expect(spoken?.playThrough).toBe(true);
    expect(spoken?.dialogueDuck).toMatchObject({ depthDb: -14, attackMs: 200 });
    const cue = tracks.find((track) => track.assetId === CATALOGUE);
    expect(cue?.playThrough).toBeUndefined();
    expect(cue?.dialogueDuck).toBeUndefined();
  });

  it("drops a voice-over the workspace does not have", () => {
    expect(resolveSfxTracks([voiceItem], new Map(), new Map())).toEqual([]);
  });
});
