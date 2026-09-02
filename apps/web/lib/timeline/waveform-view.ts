/**
 * Reduces A07's `waveform.json` (100 peaks/s, 10 RMS/s — `apps/worker-media/src/waveform.ts`)
 * down to one bucket per screen pixel for the visible range, so a draw call
 * touches at most `widthPx` samples no matter how zoomed out the timeline is
 * or how long the source media — the "virtualised drawing" the brief and
 * acceptance criteria ask for.
 */
export interface WaveformLike {
  readonly peakRate: number;
  readonly peaks: readonly number[];
  readonly rms: { readonly rate: number; readonly values: readonly number[] };
  readonly durationMs: number;
}

export interface WaveformBucket {
  /** Max peak amplitude (0-1) in this pixel's time window. */
  readonly peak: number;
  /** Average RMS energy (0-1) in this pixel's time window. */
  readonly energy: number;
}

/**
 * One bucket per pixel across `[startMs, endMs)`, each the max peak / mean
 * RMS over the source samples that fall in that pixel's time slice. When a
 * pixel spans less than one source sample (zoomed in past the peak
 * resolution), the nearest sample is used instead of an empty reduction.
 */
export function reduceWaveform(
  waveform: WaveformLike,
  startMs: number,
  endMs: number,
  widthPx: number,
): WaveformBucket[] {
  if (widthPx <= 0 || endMs <= startMs) return [];
  const msPerPx = (endMs - startMs) / widthPx;
  const buckets: WaveformBucket[] = new Array(widthPx);
  for (let px = 0; px < widthPx; px++) {
    const bucketStartMs = startMs + px * msPerPx;
    const bucketEndMs = bucketStartMs + msPerPx;
    buckets[px] = {
      peak: reduceMax(waveform.peaks, waveform.peakRate, bucketStartMs, bucketEndMs),
      energy: reduceMean(waveform.rms.values, waveform.rms.rate, bucketStartMs, bucketEndMs),
    };
  }
  return buckets;
}

function reduceMax(
  values: readonly number[],
  rateHz: number,
  startMs: number,
  endMs: number,
): number {
  const startIdx = Math.max(0, Math.floor((startMs / 1000) * rateHz));
  const endIdx = Math.min(values.length, Math.ceil((endMs / 1000) * rateHz));
  if (endIdx <= startIdx) {
    const idx = Math.min(values.length - 1, Math.max(0, Math.round((startMs / 1000) * rateHz)));
    return values[idx] ?? 0;
  }
  let max = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const v = values[i];
    if (v !== undefined && v > max) max = v;
  }
  return max;
}

function reduceMean(
  values: readonly number[],
  rateHz: number,
  startMs: number,
  endMs: number,
): number {
  const startIdx = Math.max(0, Math.floor((startMs / 1000) * rateHz));
  const endIdx = Math.min(values.length, Math.ceil((endMs / 1000) * rateHz));
  if (endIdx <= startIdx) {
    const idx = Math.min(values.length - 1, Math.max(0, Math.round((startMs / 1000) * rateHz)));
    return values[idx] ?? 0;
  }
  let sum = 0;
  let count = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const v = values[i];
    if (v !== undefined) {
      sum += v;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}
