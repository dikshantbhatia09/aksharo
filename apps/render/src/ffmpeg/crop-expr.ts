/**
 * A dynamic `crop=w:h:x:y` filter expression for the zoom/reframe crop window
 * (B20), built from the same {@link CropKeyframe} curve the browser exporter
 * samples with `@montaj/render-core`'s `sampleCropWindow`.
 *
 * ffmpeg's filter expressions (`libavutil/eval.c`) have no `lerp`, so each of
 * `x`, `y`, `w`, `h` is its own nested `if(lt(t, tN), ..., ...)` chain: at
 * `t < t1` hold `v0`; between `t1` and `t2` interpolate linearly; and so on,
 * ending in the last keyframe's value held for the rest of the clip. `t` is
 * ffmpeg's own per-frame output-clock seconds variable, available in every
 * filter that accepts time expressions — exactly the output clock this
 * module's `keyframes` are already on (`apps/web/lib/export/keyframe-adapter
 * .ts`'s browser-side counterpart remaps onto the same clock before either
 * backend sees the curve).
 *
 * **Known deviation, reported in the B20 final report**: only a `"linear"`
 * segment is exact here. A `CropKeyframe.easing` of `"easeInOutCubic"` is
 * approximated as linear in this ffmpeg expression — building the cubic in
 * ffmpeg's expression language is possible (`pow()` exists) but was out of
 * reach in this pass; the browser path (`sampleCropWindow`, run in
 * TypeScript) applies the real cubic. A reviewed export with an eased
 * zoom/reframe therefore does not currently look pixel-identical between the
 * two render paths mid-transition, only at its keyframes.
 */

import type { CropKeyframe } from "@montaj/render-core";

function seconds(tMs: number): number {
  return tMs / 1000;
}

/** Formats a number with up to 3 decimal places and strips trailing zeroes. */
function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(3);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Bounds keyframe segments to ensure ffmpeg command line stays well within OS limits. */
function simplifyKeyframes(keyframes: readonly CropKeyframe[], maxPoints = 24): CropKeyframe[] {
  if (keyframes.length <= maxPoints) return [...keyframes];
  const stride = Math.ceil(keyframes.length / maxPoints);
  const result: CropKeyframe[] = [keyframes[0]!];
  for (let i = stride; i < keyframes.length - 1; i += stride) {
    // eslint-disable-next-line security/detect-object-injection -- internal keyframe index
    result.push(keyframes[i]!);
  }
  result.push(keyframes[keyframes.length - 1]!);
  return result;
}

/** One dimension's value across every keyframe, in destination units (pixels). */
function dimensionExpr(
  keyframes: readonly CropKeyframe[],
  pick: (rect: CropKeyframe["rect"]) => number,
  scale: number,
): string {
  if (keyframes.length === 0) return "0";
  const first = keyframes[0];
  if (first === undefined) return "0";
  if (keyframes.length === 1) return fmtNum(pick(first.rect) * scale);

  const simplified = simplifyKeyframes(keyframes, 24);
  const last = simplified[simplified.length - 1];
  if (last === undefined) return "0";
  let expr = fmtNum(pick(last.rect) * scale);

  for (let i = simplified.length - 2; i >= 0; i -= 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const before = simplified[i];
    const after = simplified[i + 1];
    if (before === undefined || after === undefined) continue;
    const t0 = seconds(before.tMs);
    const t1 = seconds(after.tMs);
    const v0 = pick(before.rect) * scale;
    const v1 = pick(after.rect) * scale;
    const span = t1 - t0;
    const ramp =
      span > 0 && Math.abs(v1 - v0) > 0.05
        ? `(${fmtNum(v0)}+(${fmtNum(v1)}-${fmtNum(v0)})*(t-${fmtNum(t0)})/(${fmtNum(span)}))`
        : fmtNum(v1);
    if (i === 0) {
      // Before the first keyframe, hold its value.
      expr = `if(lt(t,${fmtNum(t0)}),${fmtNum(v0)},if(lt(t,${fmtNum(t1)}),${ramp},${expr}))`;
    } else {
      expr = `if(lt(t,${fmtNum(t1)}),${ramp},${expr})`;
    }
  }
  return expr;
}

/**
 * Builds the `crop=w:h:x:y` filter (no label, no leading `[in]`/trailing
 * `[out]` — the caller splices it into its own filter-graph string) for a
 * source of `sourceWidth`×`sourceHeight`. `null` when there is nothing to
 * crop (no accepted zoom/reframe item) — the caller should skip the filter
 * entirely rather than insert a no-op `crop=W:H:0:0`, so an unedited render's
 * filter graph is unchanged from before B20.
 */
export function buildDynamicCropFilter(
  keyframes: readonly CropKeyframe[],
  sourceWidth: number,
  sourceHeight: number,
): string | null {
  if (keyframes.length === 0) return null;
  const w = dimensionExpr(keyframes, (r) => r.w, sourceWidth);
  const h = dimensionExpr(keyframes, (r) => r.h, sourceHeight);
  const x = dimensionExpr(keyframes, (r) => r.x, sourceWidth);
  const y = dimensionExpr(keyframes, (r) => r.y, sourceHeight);
  return `crop=w='${w}':h='${h}':x='${x}':y='${y}'`;
}
