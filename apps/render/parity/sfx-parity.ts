/**
 * SFX-duck parity (D04a): `audio-parity.ts` proves the browser and cloud
 * render paths mux in byte-identical *cleaned speech* audio; this is the
 * same kind of check for the SFX duck curve — the browser path
 * (`apps/web/lib/export/engine.ts`'s `duckGainAt`, sampled per audio sample)
 * and the cloud path (`apps/render/src/ffmpeg/sfx-duck-expr.ts`'s
 * `buildSfxDuckVolumeExpr`, evaluated per ffmpeg output frame) must agree at
 * every instant, or an accepted SFX cue would sit at a different loudness
 * depending on which render path produced the export.
 *
 * Rather than shelling out to ffmpeg from this check (parity here is about
 * the *curve*, not file bytes — `audio-parity.ts` already covers "are the
 * bytes the browser and cloud fetch identical" for the one track that is
 * literally shared), this evaluates both curves' closed forms directly and
 * compares them at a dense set of sample instants across every speech range
 * plus its ramp margins, where a numerical drift between the two
 * implementations would show up first.
 */

export interface SfxDuckCurve {
  /** Gain at `tMs` (linear, browser convention) — `duckGainAt` in engine.ts. */
  gainAt(tMs: number): number;
}

export interface SfxParityInput {
  readonly speechRanges: readonly { readonly startMs: number; readonly endMs: number }[];
  readonly browserCurve: SfxDuckCurve;
  /** Evaluates the cloud ffmpeg expression at `t` seconds — a test double in
   * unit tests, ffmpeg's real `libavutil/eval.c` in an integration run. */
  readonly evaluateCloudExpr: (expr: string, tSeconds: number) => number;
  readonly buildCloudExpr: (
    speechRanges: readonly { readonly startMs: number; readonly endMs: number }[],
  ) => string;
  /** Sample instants to compare, milliseconds. Defaults to a dense sweep
   * across every range plus a 2x ramp margin on each side when omitted. */
  readonly sampleTimesMs?: readonly number[];
  readonly toleranceLinear?: number;
}

export interface SfxParityMismatch {
  readonly tMs: number;
  readonly browserGain: number;
  readonly cloudGain: number;
  readonly delta: number;
}

export interface SfxParityResult {
  readonly match: boolean;
  readonly sampleCount: number;
  readonly mismatches: readonly SfxParityMismatch[];
}

const DEFAULT_TOLERANCE = 1e-6;
const DEFAULT_RAMP_MARGIN_MS = 150;
const DEFAULT_STEP_MS = 25;

function defaultSampleTimes(
  speechRanges: readonly { readonly startMs: number; readonly endMs: number }[],
): number[] {
  const times = new Set<number>();
  for (const range of speechRanges) {
    for (
      let t = range.startMs - DEFAULT_RAMP_MARGIN_MS * 2;
      t <= range.endMs + DEFAULT_RAMP_MARGIN_MS * 2;
      t += DEFAULT_STEP_MS
    ) {
      times.add(Math.round(t));
    }
  }
  if (times.size === 0) times.add(0);
  return [...times].sort((a, b) => a - b);
}

/** Compares the browser and cloud SFX duck curves at every sample instant. */
export function computeSfxParity(input: SfxParityInput): SfxParityResult {
  const cloudExpr = input.buildCloudExpr(input.speechRanges);
  const sampleTimesMs = input.sampleTimesMs ?? defaultSampleTimes(input.speechRanges);
  const tolerance = input.toleranceLinear ?? DEFAULT_TOLERANCE;

  const mismatches: SfxParityMismatch[] = [];
  for (const tMs of sampleTimesMs) {
    const browserGain = input.browserCurve.gainAt(tMs);
    const cloudGain = input.evaluateCloudExpr(cloudExpr, tMs / 1000);
    const delta = Math.abs(browserGain - cloudGain);
    if (delta > tolerance) {
      mismatches.push({ tMs, browserGain, cloudGain, delta });
    }
  }

  return { match: mismatches.length === 0, sampleCount: sampleTimesMs.length, mismatches };
}
