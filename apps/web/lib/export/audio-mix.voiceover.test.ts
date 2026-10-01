import { describe, expect, it } from "vitest";

import { buildTimeMap, cutEdit } from "@montaj/timemap";

import {
  applyDialogueDucks,
  mixSfxCueIntoChunk,
  playedWindowOf,
  type SfxMixCue,
} from "./audio-mix";

/**
 * The voice-over hook in the browser export (2026-10-01): the twin of
 * `apps/render/src/ffmpeg/audio-mix.voiceover.test.ts`. A play-through cue plays
 * whole through later cuts, and the clip's own sound is ducked under it before
 * the cue is added.
 */
const RATE = 1_000; // one sample a millisecond keeps the arithmetic readable

function buffer(samples: number, value: number): AudioBuffer {
  const data = new Float32Array(samples).fill(value);
  return {
    length: samples,
    sampleRate: RATE,
    numberOfChannels: 1,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

function voice(overrides: Partial<SfxMixCue> = {}): SfxMixCue {
  return {
    itemId: "voice",
    startMs: 1_000,
    endMs: 2_000,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    duck: null,
    buffer: buffer(1_000, 0.5),
    playThrough: true,
    dialogueDuck: { depthDb: -20, attackMs: 100, releaseMs: 100 },
    ...overrides,
  };
}

describe("playedWindowOf (browser)", () => {
  it("keeps the whole voice through a cut after its start", () => {
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(1_400, 1_600)] });
    expect(playedWindowOf(voice(), map)).toEqual({
      outputStart: 1_000,
      outputEnd: 2_000,
      assetOffsetMs: 0,
    });
  });
});

describe("mixSfxCueIntoChunk with playThrough", () => {
  it("adds every sample of the voice, even across a cut", () => {
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(1_400, 1_600)] });
    const chunk = buffer(3_000, 0);
    mixSfxCueIntoChunk(chunk, 0, voice(), map, []);
    const data = chunk.getChannelData(0);
    expect(data[999]).toBe(0);
    expect(data[1_000]).toBeCloseTo(0.5);
    // A cut cue would have stopped at 1,800 on the output clock.
    expect(data[1_850]).toBeCloseTo(0.5);
    expect(data[1_999]).toBeCloseTo(0.5);
    expect(data[2_000]).toBe(0);
  });

  it("stops at the end of the video", () => {
    const chunk = buffer(3_000, 0);
    mixSfxCueIntoChunk(chunk, 0, voice(), null, [], 1_500);
    expect(chunk.getChannelData(0)[1_499]).toBeCloseTo(0.5);
    expect(chunk.getChannelData(0)[1_500]).toBe(0);
  });
});

describe("applyDialogueDucks", () => {
  it("pulls the clip's sound down under the voice and leaves it alone elsewhere", () => {
    const chunk = buffer(3_000, 1);
    applyDialogueDucks(chunk, 0, [voice()], null);
    const data = chunk.getChannelData(0);
    expect(data[500]).toBe(1);
    expect(data[1_500]).toBeCloseTo(0.1); // -20 dB
    expect(data[2_500]).toBe(1);
  });

  it("does nothing for a cue without a dialogue duck", () => {
    const chunk = buffer(3_000, 1);
    applyDialogueDucks(chunk, 0, [voice({ dialogueDuck: undefined })], null);
    expect(chunk.getChannelData(0)[1_500]).toBe(1);
  });
});
