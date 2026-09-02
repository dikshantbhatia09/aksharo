import { describe, expect, it } from "vitest";

import {
  acceptedRanges,
  applyAcceptedCuts,
  applyAcceptedZooms,
  applyCleanedAudio,
  toMotionKeyframes,
} from "./cutsZoomsAudio.js";
import { MockPremiereHost } from "../host/premiere.js";

import type { EdgPassItemLike } from "./types.js";

const cutAccepted: EdgPassItemLike = {
  itemId: "cut-1",
  kind: "cut",
  startFrames: 10,
  endFrames: 20,
  state: "accepted",
};
const cutProposed: EdgPassItemLike = {
  itemId: "cut-2",
  kind: "cut",
  startFrames: 30,
  endFrames: 40,
  state: "proposed",
};
const zoomAccepted: EdgPassItemLike = {
  itemId: "zoom-1",
  kind: "zoom",
  startFrames: 0,
  endFrames: 50,
  state: "accepted",
  keyframes: [
    { tMs: 0, zoom: 1, cx: 0.5, cy: 0.5, ease: "linear" },
    { tMs: 500, zoom: 1.3, cx: 0.4, cy: 0.6, ease: "inOut" },
  ],
};

describe("acceptedRanges", () => {
  it("only includes accepted items of the requested kind", () => {
    expect(acceptedRanges([cutAccepted, cutProposed], "cut")).toEqual([
      { startFrames: 10, endFrames: 20 },
    ]);
  });
});

describe("applyAcceptedCuts", () => {
  it("ripple-deletes only the accepted cut ranges", async () => {
    const host = new MockPremiereHost();
    await applyAcceptedCuts(host, [cutAccepted, cutProposed]);
    expect(host.rippleDeleteCalls).toEqual([[{ startFrames: 10, endFrames: 20 }]]);
  });

  it("does not call rippleDelete when there are no accepted cuts", async () => {
    const host = new MockPremiereHost();
    await applyAcceptedCuts(host, [cutProposed]);
    expect(host.rippleDeleteCalls).toHaveLength(0);
  });
});

describe("toMotionKeyframes", () => {
  it("converts ms-relative MKF2 rows to frame-relative motion keyframes", () => {
    const result = toMotionKeyframes(zoomAccepted, 25);
    expect(result).toEqual([
      { atFrames: 0, scale: 1, positionX: 0.5, positionY: 0.5, ease: "linear" },
      { atFrames: 13, scale: 1.3, positionX: 0.4, positionY: 0.6, ease: "inOut" },
    ]);
  });
});

describe("applyAcceptedZooms", () => {
  it("sets motion keyframes on the mapped track item for accepted zooms", async () => {
    const host = new MockPremiereHost();
    const map = new Map([["zoom-1", "track-item-1"]]);
    await applyAcceptedZooms(host, [zoomAccepted], map, 25);
    expect(host.getMotionKeyframesFor("track-item-1")).toEqual(toMotionKeyframes(zoomAccepted, 25));
  });

  it("skips a zoom with no resolved track item rather than guessing", async () => {
    const host = new MockPremiereHost();
    await applyAcceptedZooms(host, [zoomAccepted], new Map(), 25);
    expect(host.getMotionKeyframesFor("track-item-1")).toBeUndefined();
  });
});

describe("applyCleanedAudio", () => {
  it("replaces the audio range with the cleaned WAV", async () => {
    const host = new MockPremiereHost();
    await applyCleanedAudio(host, {
      cleanedAudioLocalPath: "/tmp/cleaned.wav",
      range: { startFrames: 0, endFrames: 250 },
      muteOriginalTrackIndex: 0,
    });
    expect(host.replaceAudioRangeCalls).toEqual([
      {
        sourcePath: "/tmp/cleaned.wav",
        range: { startFrames: 0, endFrames: 250 },
        muteOriginalTrackIndex: 0,
      },
    ]);
  });
});
