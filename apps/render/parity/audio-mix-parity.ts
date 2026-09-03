/**
 * D04e-3's envelope parity gate: RMS-in-50ms-windows comparison between the
 * cloud renderer's actual mixed audio (real ffmpeg, `../src/ffmpeg/
 * audio-mix.ts`'s `buildAudioMixPlan`) and a reference PCM signal computed
 * directly from the closed-form mixing formulas both engines are meant to
 * agree on — the same "reimplement, don't cross-app-import" convention
 * `run-sfx-parity.ts`'s own `browserDuckGainAt` already uses (apps do not
 * import one another in this monorepo, so `apps/web/lib/export/
 * audio-mix.ts`'s `mixSfxCueIntoChunk` cannot be called directly from here;
 * `referenceMixSamples` below is a line-for-line port of its arithmetic).
 *
 * A cue's own gain/fade/duck math is exactly the sample-domain closed form
 * `apps/web`'s mixer applies in place — this module's "reference" signal
 * *is* that computation, run once over the whole fixture instead of chunk
 * by chunk. Comparing it against ffmpeg's actual rendered bytes (`atrim`/
 * `volume`/`afade`/`adelay`/the duck `eval=frame` expression) is therefore a
 * real cross-implementation check, not a tautology: ffmpeg's filter graph is
 * a wholly different execution engine (frame-based, C, floating-point
 * accumulation order the JS reference does not share) arriving at the same
 * intended signal.
 */

export interface PcmSignal {
  /** Mono samples, one `Float32Array` entry per sample, at `sampleRate`. */
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

export interface WindowRms {
  readonly windowStartMs: number;
  readonly referenceDb: number;
  readonly cloudDb: number;
  readonly deviationDb: number;
}

export interface AudioMixParityResult {
  readonly windows: readonly WindowRms[];
  readonly maxDeviationDb: number;
  readonly pass: boolean;
}

const SILENCE_FLOOR_LINEAR = 1e-6;

function linearToDb(value: number): number {
  return 20 * Math.log10(Math.max(value, SILENCE_FLOOR_LINEAR));
}

/** RMS (linear) of `signal[startSample, endSample)`. */
function windowRmsLinear(signal: Float32Array, startSample: number, endSample: number): number {
  const from = Math.max(0, startSample);
  const to = Math.min(signal.length, endSample);
  if (to <= from) return 0;
  let sumSquares = 0;
  for (let i = from; i < to; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a loop-bounded index, not attacker-controlled
    const sample = signal[i] ?? 0;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / (to - from));
}

/**
 * Compares two same-length, same-rate PCM signals in consecutive `windowMs`
 * windows, each window's RMS converted to dBFS before comparing — so a
 * quiet mismatch (a fraction of a linear unit) and a loud one are weighed on
 * the same perceptual-ish scale, matching how the brief states the
 * tolerance ("≤0.5 dB").
 */
export function computeAudioMixParity(
  reference: PcmSignal,
  cloud: PcmSignal,
  options?: { readonly windowMs?: number; readonly toleranceDb?: number },
): AudioMixParityResult {
  if (reference.sampleRate !== cloud.sampleRate) {
    throw new Error(
      `sample rates differ: reference ${String(reference.sampleRate)} vs cloud ${String(cloud.sampleRate)}`,
    );
  }
  const windowMs = options?.windowMs ?? 50;
  const toleranceDb = options?.toleranceDb ?? 0.5;
  const sampleRate = reference.sampleRate;
  const windowSamples = Math.round((windowMs / 1000) * sampleRate);
  const totalSamples = Math.min(reference.samples.length, cloud.samples.length);

  const windows: WindowRms[] = [];
  let maxDeviationDb = 0;
  for (let start = 0; start < totalSamples; start += windowSamples) {
    const end = Math.min(start + windowSamples, totalSamples);
    const referenceDb = linearToDb(windowRmsLinear(reference.samples, start, end));
    const cloudDb = linearToDb(windowRmsLinear(cloud.samples, start, end));
    const deviationDb = Math.abs(referenceDb - cloudDb);
    maxDeviationDb = Math.max(maxDeviationDb, deviationDb);
    windows.push({ windowStartMs: (start / sampleRate) * 1000, referenceDb, cloudDb, deviationDb });
  }

  return { windows, maxDeviationDb, pass: maxDeviationDb <= toleranceDb };
}

/** `true` when the RMS in `[startMs, endMs)` is at least `aboveFloorDb`
 * louder than the true-silence floor — the brief's "cue-window presence
 * check", applied to whichever signal is passed in. */
export function cueWindowIsPresent(
  signal: PcmSignal,
  startMs: number,
  endMs: number,
  aboveFloorDb = 6,
): boolean {
  const startSample = Math.round((startMs / 1000) * signal.sampleRate);
  const endSample = Math.round((endMs / 1000) * signal.sampleRate);
  const db = linearToDb(windowRmsLinear(signal.samples, startSample, endSample));
  return db > linearToDb(SILENCE_FLOOR_LINEAR) + aboveFloorDb;
}
