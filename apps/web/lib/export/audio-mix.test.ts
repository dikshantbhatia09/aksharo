import { describe, expect, it } from "vitest";

import { buildTimeMap, cutEdit } from "@montaj/timemap";

import {
  mixMusicCueIntoChunk,
  mixSfxCueIntoChunk,
  speechRangesFromWords,
  type MusicMixCue,
  type SfxMixCue,
} from "./audio-mix";

const SAMPLE_RATE = 48_000;

/** A minimal duck-typed stand-in for `AudioBuffer` — Node has no such global —
 * matching `engine.test.ts`'s own `fakeAudioBuffer` helper. */
function fakeAudioBuffer(samples: number, sampleRate: number, value = 0): AudioBuffer {
  const data = new Float32Array(samples).fill(value);
  return {
    length: samples,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

describe("speechRangesFromWords", () => {
  it("merges close words and clamps to duration", () => {
    expect(
      speechRangesFromWords(
        [
          { s: 0, e: 400 },
          { s: 450, e: 900 },
          { s: 2_000, e: 2_500 },
        ],
        3_000,
      ),
    ).toEqual([
      { startMs: 0, endMs: 900 },
      { startMs: 2_000, endMs: 2_500 },
    ]);
  });
});

describe("mixSfxCueIntoChunk — unedited timeline", () => {
  it("adds the cue's samples into the overlapping chunk window, elsewhere unchanged", () => {
    // A 1-second chunk (48000 samples) starting at output ms 0; the cue plays
    // from 200ms to 300ms within it, at full gain, constant value 1.
    const chunk = fakeAudioBuffer(SAMPLE_RATE, SAMPLE_RATE, 0);
    const cueBuffer = fakeAudioBuffer(Math.round(0.1 * SAMPLE_RATE), SAMPLE_RATE, 1);
    const cue: SfxMixCue = {
      itemId: "cue-1",
      startMs: 200,
      endMs: 300,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      duck: null,
      buffer: cueBuffer,
    };

    mixSfxCueIntoChunk(chunk, 0, cue, null, []);

    const data = chunk.getChannelData(0);
    const beforeIndex = Math.round(0.199 * SAMPLE_RATE);
    const insideIndex = Math.round(0.25 * SAMPLE_RATE);
    const afterIndex = Math.round(0.301 * SAMPLE_RATE);
    expect(data.at(beforeIndex)).toBe(0);
    expect(data.at(insideIndex)).toBeCloseTo(1, 5);
    expect(data.at(afterIndex)).toBe(0);
  });

  it("applies gainDb as a linear scale", () => {
    const chunk = fakeAudioBuffer(SAMPLE_RATE, SAMPLE_RATE, 0);
    const cueBuffer = fakeAudioBuffer(Math.round(0.1 * SAMPLE_RATE), SAMPLE_RATE, 1);
    const cue: SfxMixCue = {
      itemId: "cue-1",
      startMs: 0,
      endMs: 100,
      gainDb: -6,
      fadeInMs: 0,
      fadeOutMs: 0,
      duck: null,
      buffer: cueBuffer,
    };
    mixSfxCueIntoChunk(chunk, 0, cue, null, []);
    const data = chunk.getChannelData(0);
    expect(data[Math.round(0.05 * SAMPLE_RATE)]).toBeCloseTo(0.501187, 4);
  });

  it("ramps the fade-in linearly from the cue's own start", () => {
    const chunk = fakeAudioBuffer(SAMPLE_RATE, SAMPLE_RATE, 0);
    const cueBuffer = fakeAudioBuffer(Math.round(0.1 * SAMPLE_RATE), SAMPLE_RATE, 1);
    const cue: SfxMixCue = {
      itemId: "cue-1",
      startMs: 0,
      endMs: 100,
      gainDb: 0,
      fadeInMs: 20,
      fadeOutMs: 0,
      duck: null,
      buffer: cueBuffer,
    };
    mixSfxCueIntoChunk(chunk, 0, cue, null, []);
    const data = chunk.getChannelData(0);
    // Halfway through the 20ms fade-in, gain should be ~0.5.
    expect(data[Math.round(0.01 * SAMPLE_RATE)]).toBeCloseTo(0.5, 1);
    // Well past the fade-in, full gain.
    expect(data[Math.round(0.05 * SAMPLE_RATE)]).toBeCloseTo(1, 4);
  });

  it("ducks the cue under a speech range", () => {
    const chunk = fakeAudioBuffer(SAMPLE_RATE, SAMPLE_RATE, 0);
    const cueBuffer = fakeAudioBuffer(SAMPLE_RATE, SAMPLE_RATE, 1);
    const cue: SfxMixCue = {
      itemId: "cue-1",
      startMs: 0,
      endMs: 1_000,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      duck: { depthDb: -12, attackMs: 150, releaseMs: 150 },
      buffer: cueBuffer,
    };
    // Deep inside a wide speech range, well past the ramp — fully ducked.
    mixSfxCueIntoChunk(chunk, 0, cue, null, [{ startMs: 0, endMs: 1_000 }]);
    const data = chunk.getChannelData(0);
    const duckedGain = Math.pow(10, -12 / 20);
    expect(data[Math.round(0.5 * SAMPLE_RATE)]).toBeCloseTo(duckedGain, 3);
  });
});

describe("mixSfxCueIntoChunk — remapped across a cut", () => {
  it("places the cue at its output-clock start, split at the cut the same way the cloud graph is", () => {
    // Source 0..10s; cut removes [2400,2600) — mid-cue for a [2000,3000) cue.
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(2_400, 2_600)] });
    const cueBuffer = fakeAudioBuffer(SAMPLE_RATE, SAMPLE_RATE, 1);
    const cue: SfxMixCue = {
      itemId: "cue-1",
      startMs: 2_000,
      endMs: 3_000,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      duck: null,
      buffer: cueBuffer,
    };
    // A 4-second chunk covering the whole output timeline.
    const chunk = fakeAudioBuffer(4 * SAMPLE_RATE, SAMPLE_RATE, 0);
    mixSfxCueIntoChunk(chunk, 0, cue, map, []);
    const data = chunk.getChannelData(0);
    // First piece: output [2000,2400) plays asset-local [0,400).
    expect(data[Math.round(2.2 * SAMPLE_RATE)]).toBeCloseTo(1, 4);
    // The cut itself: output instant right at 2400ms should already be the
    // second piece (asset-local 600ms onward), still cue audio.
    expect(data[Math.round(2.45 * SAMPLE_RATE)]).toBeCloseTo(1, 4);
    // Well after the (ripple-shortened) cue ends at output 2800ms, silence.
    expect(data[Math.round(3.5 * SAMPLE_RATE)]).toBe(0);
  });
});

describe("mixMusicCueIntoChunk", () => {
  it("loops a shorter asset to fill its window when loopPolicy is loop", () => {
    const chunk = fakeAudioBuffer(2 * SAMPLE_RATE, SAMPLE_RATE, 0);
    // A 0.5s asset: index 0 = 2, everything else = 1, so a wrap is visible.
    const assetSamples = Math.round(0.5 * SAMPLE_RATE);
    const assetData = new Float32Array(assetSamples).fill(1);
    assetData[0] = 2;
    const buffer = {
      length: assetSamples,
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 1,
      getChannelData: () => assetData,
    } as unknown as AudioBuffer;

    const music: MusicMixCue = {
      itemId: "music-1",
      startMs: 0,
      endMs: 2_000,
      gainDb: 0,
      loopPolicy: "loop",
      bedDuck: null,
      buffer,
    };
    mixMusicCueIntoChunk(chunk, 0, music, null, []);
    const data = chunk.getChannelData(0);
    // One full asset length in (0.5s), the loop wraps back to index 0 (value 2).
    expect(data.at(assetSamples)).toBeCloseTo(2, 4);
    expect(data.at(Math.round(0.4 * SAMPLE_RATE))).toBeCloseTo(1, 4);
  });

  it("applies D05's fixed 300ms fade-in at the bed's own start", () => {
    const chunk = fakeAudioBuffer(2 * SAMPLE_RATE, SAMPLE_RATE, 0);
    const buffer = fakeAudioBuffer(2 * SAMPLE_RATE, SAMPLE_RATE, 1);
    const music: MusicMixCue = {
      itemId: "music-1",
      startMs: 0,
      endMs: 2_000,
      gainDb: 0,
      loopPolicy: "none",
      bedDuck: null,
      buffer,
    };
    mixMusicCueIntoChunk(chunk, 0, music, null, []);
    const data = chunk.getChannelData(0);
    // Halfway through the 300ms fade-in, gain should be ~0.5.
    expect(data.at(Math.round(0.15 * SAMPLE_RATE))).toBeCloseTo(0.5, 1);
    // Well past the fade-in and well before the fade-out, full gain.
    expect(data.at(Math.round(1.0 * SAMPLE_RATE))).toBeCloseTo(1, 4);
  });

  it("applies D05's fixed 800ms fade-out at the bed's own end", () => {
    const chunk = fakeAudioBuffer(2 * SAMPLE_RATE, SAMPLE_RATE, 0);
    const buffer = fakeAudioBuffer(2 * SAMPLE_RATE, SAMPLE_RATE, 1);
    const music: MusicMixCue = {
      itemId: "music-1",
      startMs: 0,
      endMs: 2_000,
      gainDb: 0,
      loopPolicy: "none",
      bedDuck: null,
      buffer,
    };
    mixMusicCueIntoChunk(chunk, 0, music, null, []);
    const data = chunk.getChannelData(0);
    // Halfway through the 800ms fade-out (window ends at 2000ms, fade starts
    // at 1200ms), gain should be ~0.5.
    expect(data.at(Math.round(1.6 * SAMPLE_RATE))).toBeCloseTo(0.5, 1);
    // Right at the very end, gain should be ~0.
    expect(data.at(2 * SAMPLE_RATE - 1)).toBeCloseTo(0, 1);
  });

  it("ducks a bed under speech via bedDuck, same trapezoid as an sfx cue's duck", () => {
    const chunk = fakeAudioBuffer(3 * SAMPLE_RATE, SAMPLE_RATE, 0);
    const buffer = fakeAudioBuffer(3 * SAMPLE_RATE, SAMPLE_RATE, 1);
    const music: MusicMixCue = {
      itemId: "music-1",
      startMs: 0,
      endMs: 3_000,
      gainDb: 0,
      loopPolicy: "none",
      bedDuck: { depthDb: -18, attackMs: 100, releaseMs: 100 },
      buffer,
    };
    mixMusicCueIntoChunk(chunk, 0, music, null, [{ startMs: 0, endMs: 3_000 }]);
    const data = chunk.getChannelData(0);
    const duckedGain = Math.pow(10, -18 / 20);
    // Deep inside the speech range, past both the duck ramp and the fade-in.
    expect(data.at(Math.round(0.5 * SAMPLE_RATE))).toBeCloseTo(duckedGain, 3);
  });
});
