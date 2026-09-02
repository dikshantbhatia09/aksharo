import { createReadStream } from "node:fs";

/**
 * `waveform.json`: the peaks the editor draws, built from the 16 kHz PCM we have
 * already written.
 *
 * Two envelopes at two rates, because they answer different questions:
 *
 * - **peaks at 100/s** — one value per 10 ms, the absolute maximum in that
 *   window. This is the jagged outline a timeline draws, and a peak envelope is
 *   what makes a transient (a clap, a plosive) visible at all; an RMS envelope
 *   smooths those away.
 * - **RMS at 10/s** — one value per 100 ms, the energy in that window. This is
 *   what "is anyone talking here" looks like, and it is what a silence ruler and
 *   an auto-cut heat map read.
 *
 * Both normalised to 0–1 against full scale, not against the file's own maximum:
 * two clips in the same timeline have to be comparable, and a self-normalised
 * envelope makes a whisper and a shout draw identically.
 *
 * **Streaming, in fixed-size chunks.** A sixty-minute 16 kHz mono s16 file is
 * 115 MB. Reading it into a Buffer to compute a 2 MB summary would be the one
 * place this worker undid the "never load the file into memory" rule it keeps
 * everywhere else — so the accumulator is two running numbers per window and the
 * file goes past in 64 KiB pieces.
 */

/** Peaks per second: one value per 10 ms. */
export const PEAK_RATE_HZ = 100;

/** RMS samples per second: one value per 100 ms. */
export const RMS_RATE_HZ = 10;

/** `waveform.json`'s own version, so a reader can tell an old sidecar apart. */
export const WAVEFORM_VERSION = 1;

/** Full scale for signed 16-bit PCM. */
const FULL_SCALE = 32_768;

/** Bytes read at a time. Large enough to be one syscall, small enough to be free. */
const CHUNK_BYTES = 64 * 1024;

/** Canonical WAV header length for the PCM ffmpeg writes (no extra chunks). */
export const WAV_HEADER_BYTES = 44;

export interface Waveform extends Record<string, unknown> {
  readonly version: number;
  readonly mediaId: string;
  readonly durationMs: number;
  readonly channels: number;
  readonly sampleRate: number;
  /** Peaks per second. */
  readonly peakRate: number;
  /** Absolute peak per window, 0–1. */
  readonly peaks: readonly number[];
  /** RMS energy per window, 0–1, at {@link RMS_RATE_HZ}. */
  readonly rms: {
    readonly rate: number;
    readonly values: readonly number[];
  };
}

/**
 * A running accumulator over interleaved-free mono s16le samples.
 *
 * Exposed rather than hidden inside the file reader so the arithmetic can be
 * tested against a signal whose answer is known — a full-scale square wave is 1.0
 * peak and 1.0 RMS, a half-scale sine is 0.5 peak and 0.354 RMS — without writing
 * a WAV file to do it.
 */
export class WaveformAccumulator {
  private readonly samplesPerPeak: number;
  private readonly samplesPerRms: number;

  private readonly peaks: number[] = [];
  private readonly rms: number[] = [];

  private peakWindowMax = 0;
  private peakWindowCount = 0;
  private rmsWindowSum = 0;
  private rmsWindowCount = 0;
  private total = 0;

  constructor(private readonly sampleRate: number) {
    this.samplesPerPeak = Math.max(1, Math.round(sampleRate / PEAK_RATE_HZ));
    this.samplesPerRms = Math.max(1, Math.round(sampleRate / RMS_RATE_HZ));
  }

  /** Feed one sample, as the raw signed 16-bit integer. */
  push(sample: number): void {
    const normalised = Math.min(1, Math.abs(sample) / FULL_SCALE);
    this.total += 1;

    this.peakWindowMax = Math.max(this.peakWindowMax, normalised);
    if (++this.peakWindowCount >= this.samplesPerPeak) this.flushPeak();

    this.rmsWindowSum += normalised * normalised;
    if (++this.rmsWindowCount >= this.samplesPerRms) this.flushRms();
  }

  /** Feed a buffer of little-endian s16 samples. Odd trailing bytes are ignored. */
  pushBuffer(chunk: Buffer): void {
    const usable = chunk.length - (chunk.length % 2);
    for (let offset = 0; offset < usable; offset += 2) {
      this.push(chunk.readInt16LE(offset));
    }
  }

  /** How many samples have been fed. */
  get sampleCount(): number {
    return this.total;
  }

  /** Close the partial windows and return both envelopes. */
  finish(): { peaks: number[]; rms: number[]; durationMs: number } {
    if (this.peakWindowCount > 0) this.flushPeak();
    if (this.rmsWindowCount > 0) this.flushRms();
    return {
      peaks: this.peaks,
      rms: this.rms,
      durationMs: Math.round((this.total / this.sampleRate) * 1000),
    };
  }

  private flushPeak(): void {
    this.peaks.push(round3(this.peakWindowMax));
    this.peakWindowMax = 0;
    this.peakWindowCount = 0;
  }

  private flushRms(): void {
    this.rms.push(round3(Math.sqrt(this.rmsWindowSum / this.rmsWindowCount)));
    this.rmsWindowSum = 0;
    this.rmsWindowCount = 0;
  }
}

/**
 * Build a waveform from a mono 16-bit PCM WAV on disk.
 *
 * The header is skipped by byte count rather than parsed: this reads only files
 * this worker wrote a moment ago with `-c:a pcm_s16le -f wav`, whose header is
 * always the canonical 44 bytes. Parsing chunk ids to support a WAV the worker
 * did not write would be code with no caller.
 */
export async function buildWaveform(input: {
  readonly file: string;
  readonly mediaId: string;
  readonly sampleRate: number;
  /** The container's duration, used when the audio is shorter than the video. */
  readonly durationMs: number;
}): Promise<Waveform> {
  const accumulator = new WaveformAccumulator(input.sampleRate);
  const stream = createReadStream(input.file, {
    start: WAV_HEADER_BYTES,
    highWaterMark: CHUNK_BYTES,
  });

  // A chunk boundary can fall between the two bytes of a sample, so the odd byte
  // is carried into the next chunk rather than dropped — otherwise every 64 KiB
  // would shift the phase of everything after it.
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    const buffer = carry.length === 0 ? (chunk as Buffer) : Buffer.concat([carry, chunk as Buffer]);
    const usable = buffer.length - (buffer.length % 2);
    accumulator.pushBuffer(buffer.subarray(0, usable));
    carry = usable === buffer.length ? Buffer.alloc(0) : buffer.subarray(usable);
  }

  const { peaks, rms, durationMs } = accumulator.finish();
  return {
    version: WAVEFORM_VERSION,
    mediaId: input.mediaId,
    // The audio track can be a few milliseconds shorter than the container; the
    // timeline is drawn against the container, so that is the number recorded.
    durationMs: input.durationMs > 0 ? input.durationMs : durationMs,
    channels: 1,
    sampleRate: input.sampleRate,
    peakRate: PEAK_RATE_HZ,
    peaks,
    rms: { rate: RMS_RATE_HZ, values: rms },
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
