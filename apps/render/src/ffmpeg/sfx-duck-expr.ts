/**
 * The cloud-render twin of `apps/web/lib/export/engine.ts`'s `duckGainAt`
 * (D04a; 09-ai-pipeline §6): −12 dB duck under speech, 150 ms linear ramps
 * on both edges of every speech range. The browser path samples the curve
 * per-sample in JS; the cloud path bakes the identical closed-form trapezoid
 * into an ffmpeg `volume` filter's time expression (`libavutil/eval.c`),
 * evaluated per-frame (`eval=frame`) against ffmpeg's own `t` (output-clock
 * seconds) — the same clock `crop-expr.ts`'s dynamic crop already uses.
 *
 * Unlike the crop-window curve (keyframe-interpolated, needs a nested
 * `if`-chain), a duck trapezoid is closed-form per range — `between()` and
 * `min()` express it directly, no chain needed — so this stays exact rather
 * than the crop path's documented linear approximation of an eased curve.
 */

export const SFX_DUCK_DB = -12;
export const SFX_DUCK_RAMP_MS = 150;

export interface SpeechRange {
  readonly startMs: number;
  readonly endMs: number;
}

function seconds(ms: number): number {
  return ms / 1000;
}

/** `10^(db/20)`, matching `apps/web/lib/export/engine.ts`'s `dbToLinear`. */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * One speech range's trapezoid, as an ffmpeg expression fragment: `1` outside
 * `[start - rampMs, end + rampMs]`, the ducked linear gain inside it,
 * `libavutil/eval.c`'s `between(x,min,max)` and `min(...)` doing the work a
 * `CropKeyframe` chain would otherwise need nested `if`s for.
 */
function rangeExpr(range: SpeechRange, duckedGain: number, rampMs: number): string {
  const outerStart = seconds(range.startMs - rampMs);
  const outerEnd = seconds(range.endMs + rampMs);
  const rampS = seconds(rampMs);
  const distanceIn = `min(t-(${String(outerStart)}),(${String(outerEnd)})-t)`;
  const depth = `min(1,(${distanceIn})/(${String(2 * rampS)}))`;
  const gain = `(1+(${depth})*(${String(duckedGain)}-1))`;
  return `if(between(t,${String(outerStart)},${String(outerEnd)}),${gain},1)`;
}

/**
 * Builds the full `volume` filter value expression: the minimum (deepest
 * duck) across every speech range's trapezoid, `1` (no duck at all) when
 * there are no speech ranges — matching `duckGainAt([])` returning `1`.
 *
 * Used as: `-af "volume=eval=frame:volume='<expr>'"` on the SFX cue's own
 * decoded stream before it is mixed (`amix`/`sidechaincompress` handles
 * ducking the *other* tracks under speech elsewhere in the graph; this
 * expression is D04a's cue-gain duck specifically, per the brief's "ducking
 * −12 dB under speech" applied to the SFX layer itself).
 */
export function buildSfxDuckVolumeExpr(
  speechRanges: readonly SpeechRange[],
  options?: { readonly duckDb?: number; readonly rampMs?: number },
): string {
  const duckDb = options?.duckDb ?? SFX_DUCK_DB;
  const rampMs = options?.rampMs ?? SFX_DUCK_RAMP_MS;
  const duckedGain = dbToLinear(duckDb);

  if (speechRanges.length === 0) return "1";

  const terms = speechRanges.map((range) => rangeExpr(range, duckedGain, rampMs));
  return terms.length === 1 ? (terms[0] ?? "1") : `min(${terms.join(",")})`;
}

/** The complete `-af` filter argument for one SFX cue's ducked mix. */
export function buildSfxDuckAudioFilter(
  speechRanges: readonly SpeechRange[],
  options?: { readonly duckDb?: number; readonly rampMs?: number },
): string {
  const expr = buildSfxDuckVolumeExpr(speechRanges, options).replace(/'/g, "\\'");
  return `volume=eval=frame:volume='${expr}'`;
}
