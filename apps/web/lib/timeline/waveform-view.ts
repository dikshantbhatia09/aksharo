/**
 * Reduces A07's `waveform.json` (100 peaks/s, 10 RMS/s — `apps/worker-media/src/waveform.ts`)
 * down to one bucket per screen pixel for the visible range, so a draw call
 * touches at most `widthPx` samples no matter how zoomed out the timeline is
 * or how long the source media — the "virtualised drawing" the brief and
 * acceptance criteria ask for.
 */
import type { Viewport } from "./coords";

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
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    buckets[px] = {
      peak: reduceMax(waveform.peaks, waveform.peakRate, bucketStartMs, bucketEndMs),
      energy: reduceMean(waveform.rms.values, waveform.rms.rate, bucketStartMs, bucketEndMs),
    };
  }
  return buckets;
}

export interface WaveformDrawWindow {
  /** Canvas x (px) where the waveform starts — `reduceWaveform`'s bucket 0. */
  readonly pxStart: number;
  /** How many buckets/pixels wide the drawn waveform is. */
  readonly widthPx: number;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The pixel-aligned window `reduceWaveform` should reduce over, bounded to
 * `[0, durationMs]` rather than the caller's full canvas width.
 *
 * A viewport routinely shows more than the media's duration — a 20 s clip at
 * the default 30 ms/px zoom already shows ~35 s of ruler (`Timeline.tsx`'s
 * own `rulerEndMs` comment) — so asking `reduceWaveform` for `widthPx`
 * buckets over a *narrower*, duration-clamped ms range while still drawing
 * bucket `i` at canvas x = `i` silently stretches that narrower slice of
 * audio across the whole canvas: the waveform then visibly runs past where
 * the media (and the ruler) actually end. Reducing over only the pixel span
 * `[0, durationMs]` maps to, and drawing at that span's own offset, keeps
 * one bucket per pixel end to end and ends the waveform exactly on the
 * media's duration. Returns `undefined` when nothing of `[0, durationMs]`
 * falls inside `visible`.
 */
export function waveformDrawWindow(
  viewport: Viewport,
  durationMs: number,
  visible: { readonly startMs: number; readonly endMs: number },
): WaveformDrawWindow | undefined {
  if (durationMs <= 0) return undefined;
  const startMs = Math.max(0, visible.startMs);
  const endMs = Math.min(durationMs, visible.endMs);
  if (endMs <= startMs) return undefined;
  const pxStart = Math.max(0, Math.floor((startMs - viewport.scrollMs) / viewport.msPerPx));
  const pxEnd = Math.min(
    viewport.widthPx,
    Math.ceil((endMs - viewport.scrollMs) / viewport.msPerPx),
  );
  const widthPx = pxEnd - pxStart;
  if (widthPx <= 0) return undefined;
  return { pxStart, widthPx, startMs, endMs };
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
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    return values[idx] ?? 0;
  }
  let max = 0;
  for (let i = startIdx; i < endIdx; i++) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
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
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    return values[idx] ?? 0;
  }
  let sum = 0;
  let count = 0;
  for (let i = startIdx; i < endIdx; i++) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const v = values[i];
    if (v !== undefined) {
      sum += v;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}
