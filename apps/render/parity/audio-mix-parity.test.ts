import { describe, expect, it } from "vitest";

import { computeAudioMixParity, cueWindowIsPresent, type PcmSignal } from "./audio-mix-parity.js";

const SAMPLE_RATE = 1_000; // Deliberately low — these are pure-arithmetic tests, no audio involved.

function silence(seconds: number): Float32Array {
  return new Float32Array(seconds * SAMPLE_RATE);
}

function withTone(
  base: Float32Array,
  startSec: number,
  endSec: number,
  value: number,
): Float32Array {
  const copy = base.slice();
  const start = Math.round(startSec * SAMPLE_RATE);
  const end = Math.round(endSec * SAMPLE_RATE);
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a loop-bounded index, not attacker-controlled
  for (let i = start; i < end; i += 1) copy[i] = value;
  return copy;
}

describe("computeAudioMixParity", () => {
  it("passes with zero deviation when the two signals are identical", () => {
    const samples = withTone(silence(2), 0.5, 1, 0.5);
    const signal: PcmSignal = { samples, sampleRate: SAMPLE_RATE };
    const result = computeAudioMixParity(signal, { ...signal, samples: samples.slice() });
    expect(result.pass).toBe(true);
    expect(result.maxDeviationDb).toBe(0);
  });

  it("fails when one signal is measurably louder in a window", () => {
    const reference: PcmSignal = {
      samples: withTone(silence(2), 0.5, 1, 0.1),
      sampleRate: SAMPLE_RATE,
    };
    const cloud: PcmSignal = {
      samples: withTone(silence(2), 0.5, 1, 0.5),
      sampleRate: SAMPLE_RATE,
    };
    const result = computeAudioMixParity(reference, cloud, { toleranceDb: 0.5 });
    expect(result.pass).toBe(false);
    expect(result.maxDeviationDb).toBeGreaterThan(0.5);
  });

  it("throws on mismatched sample rates", () => {
    const a: PcmSignal = { samples: silence(1), sampleRate: SAMPLE_RATE };
    const b: PcmSignal = { samples: silence(1), sampleRate: SAMPLE_RATE * 2 };
    expect(() => computeAudioMixParity(a, b)).toThrow(/sample rates differ/);
  });

  it("windows the comparison at the requested size", () => {
    const samples = silence(1);
    const signal: PcmSignal = { samples, sampleRate: SAMPLE_RATE };
    const result = computeAudioMixParity(
      signal,
      { ...signal, samples: samples.slice() },
      {
        windowMs: 100,
      },
    );
    // 1 second at 100ms windows = 10 windows.
    expect(result.windows).toHaveLength(10);
  });
});

describe("cueWindowIsPresent", () => {
  it("is true when a cue window is clearly above the silence floor", () => {
    const signal: PcmSignal = {
      samples: withTone(silence(2), 0.5, 1, 0.5),
      sampleRate: SAMPLE_RATE,
    };
    expect(cueWindowIsPresent(signal, 500, 1_000)).toBe(true);
  });

  it("is false for a window that is still silent", () => {
    const signal: PcmSignal = {
      samples: withTone(silence(2), 0.5, 1, 0.5),
      sampleRate: SAMPLE_RATE,
    };
    expect(cueWindowIsPresent(signal, 1_200, 1_500)).toBe(false);
  });
});
