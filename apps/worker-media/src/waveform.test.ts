import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PEAK_RATE_HZ,
  RMS_RATE_HZ,
  WAVEFORM_VERSION,
  WAV_HEADER_BYTES,
  WaveformAccumulator,
  buildWaveform,
} from "./waveform.js";

const SAMPLE_RATE = 16_000;

/** A WAV with the canonical 44-byte header ffmpeg writes, and the given samples. */
function wav(samples: readonly number[]): Buffer {
  const body = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    body.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample))), index * 2);
  });
  return Buffer.concat([Buffer.alloc(WAV_HEADER_BYTES), body]);
}

describe("WaveformAccumulator", () => {
  it("normalises against full scale, not against the file's own maximum", () => {
    // Two clips in one timeline have to be comparable: self-normalising would
    // draw a whisper and a shout identically.
    const accumulator = new WaveformAccumulator(SAMPLE_RATE);
    for (let index = 0; index < SAMPLE_RATE; index += 1) accumulator.push(16_384);
    const { peaks } = accumulator.finish();
    expect(peaks[0]).toBeCloseTo(0.5, 2);
  });

  it("measures a full-scale square wave as 1.0 peak and 1.0 RMS", () => {
    const accumulator = new WaveformAccumulator(SAMPLE_RATE);
    for (let index = 0; index < SAMPLE_RATE; index += 1) {
      accumulator.push(index % 2 === 0 ? 32_767 : -32_768);
    }
    const { peaks, rms } = accumulator.finish();
    expect(Math.max(...peaks)).toBeCloseTo(1, 2);
    expect(Math.max(...rms)).toBeCloseTo(1, 2);
  });

  it("measures a half-scale sine as 0.5 peak and 0.354 RMS", () => {
    // RMS of a sine is its amplitude over root two; the arithmetic is the point.
    const accumulator = new WaveformAccumulator(SAMPLE_RATE);
    for (let index = 0; index < SAMPLE_RATE; index += 1) {
      accumulator.push(16_384 * Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE));
    }
    const { peaks, rms } = accumulator.finish();
    expect(Math.max(...peaks)).toBeCloseTo(0.5, 2);
    expect(rms[2]).toBeCloseTo(0.354, 2);
  });

  it("emits one peak per 10 ms and one RMS per 100 ms", () => {
    const accumulator = new WaveformAccumulator(SAMPLE_RATE);
    for (let index = 0; index < SAMPLE_RATE; index += 1) accumulator.push(1_000);
    const { peaks, rms, durationMs } = accumulator.finish();
    expect(peaks).toHaveLength(PEAK_RATE_HZ);
    expect(rms).toHaveLength(RMS_RATE_HZ);
    expect(durationMs).toBe(1_000);
  });

  it("closes a partial window rather than dropping the tail", () => {
    const accumulator = new WaveformAccumulator(SAMPLE_RATE);
    // Two and a half peak windows' worth.
    for (let index = 0; index < 400; index += 1) accumulator.push(32_767);
    expect(accumulator.finish().peaks).toHaveLength(3);
  });

  it("is silent for silence", () => {
    const accumulator = new WaveformAccumulator(SAMPLE_RATE);
    for (let index = 0; index < SAMPLE_RATE; index += 1) accumulator.push(0);
    const { peaks, rms } = accumulator.finish();
    expect(Math.max(...peaks)).toBe(0);
    expect(Math.max(...rms)).toBe(0);
  });
});

describe("buildWaveform", () => {
  let dir = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "montaj-waveform-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a WAV off disk and produces both envelopes", async () => {
    const file = join(dir, "one-second.wav");
    const samples = Array.from({ length: SAMPLE_RATE }, (_unused, index) =>
      index < SAMPLE_RATE / 2 ? 32_767 : 0,
    );
    await writeFile(file, wav(samples));

    const waveform = await buildWaveform({
      file,
      mediaId: "01JCMED1A00000000000000000",
      sampleRate: SAMPLE_RATE,
      durationMs: 1_000,
    });

    expect(waveform.version).toBe(WAVEFORM_VERSION);
    expect(waveform.peakRate).toBe(PEAK_RATE_HZ);
    expect(waveform.rms.rate).toBe(RMS_RATE_HZ);
    expect(waveform.peaks).toHaveLength(PEAK_RATE_HZ);
    expect(waveform.rms.values).toHaveLength(RMS_RATE_HZ);
    // Loud in the first half, silent in the second.
    expect(waveform.peaks[0]).toBeCloseTo(1, 2);
    expect(waveform.peaks[99]).toBe(0);
    expect(waveform.channels).toBe(1);
  });

  it("keeps the phase across a read-buffer boundary", async () => {
    // The chunk size is 64 KiB, which is an even byte count — but a partial read
    // can still split a sample, and dropping the odd byte would shift every
    // sample after it by one and turn the waveform into noise.
    const file = join(dir, "long.wav");
    const total = SAMPLE_RATE * 8;
    const samples = Array.from({ length: total }, (_unused, index) =>
      index % 2 === 0 ? 32_767 : -32_768,
    );
    await writeFile(file, wav(samples));

    const waveform = await buildWaveform({
      file,
      mediaId: "01JCMED1A00000000000000000",
      sampleRate: SAMPLE_RATE,
      durationMs: 8_000,
    });
    expect(waveform.peaks).toHaveLength(800);
    // A square wave is full scale everywhere, including after every boundary.
    expect(Math.min(...waveform.peaks)).toBeCloseTo(1, 2);
  });

  it("records the container's duration, not the audio track's", async () => {
    // The audio can be a few milliseconds shorter than the video; the timeline is
    // drawn against the container.
    const file = join(dir, "short-audio.wav");
    await writeFile(file, wav(Array.from({ length: SAMPLE_RATE }, () => 1_000)));
    const waveform = await buildWaveform({
      file,
      mediaId: "01JCMED1A00000000000000000",
      sampleRate: SAMPLE_RATE,
      durationMs: 1_040,
    });
    expect(waveform.durationMs).toBe(1_040);
  });

  it("falls back to the measured duration when the container declares none", async () => {
    const file = join(dir, "no-duration.wav");
    await writeFile(file, wav(Array.from({ length: SAMPLE_RATE * 2 }, () => 500)));
    const waveform = await buildWaveform({
      file,
      mediaId: "01JCMED1A00000000000000000",
      sampleRate: SAMPLE_RATE,
      durationMs: 0,
    });
    expect(waveform.durationMs).toBe(2_000);
  });
});
