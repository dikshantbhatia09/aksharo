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

/** One dimension's value across every keyframe, in destination units (pixels). */
function dimensionExpr(keyframes: readonly CropKeyframe[], pick: (rect: CropKeyframe["rect"]) => number, scale: number): string {
  if (keyframes.length === 0) return "0";
  const first = keyframes[0];
  if (first === undefined) return "0";
  if (keyframes.length === 1) return String(pick(first.rect) * scale);

  // Build from the last segment inward, so each `if` chain's `else` is the
  // chain built for everything after it — the last keyframe's value is the
  // innermost `else`.
  const last = keyframes[keyframes.length - 1];
  if (last === undefined) return "0";
  let expr = String(pick(last.rect) * scale);

  for (let i = keyframes.length - 2; i >= 0; i -= 1) {
    const before = keyframes[i];
    const after = keyframes[i + 1];
    if (before === undefined || after === undefined) continue;
    const t0 = seconds(before.tMs);
    const t1 = seconds(after.tMs);
    const v0 = pick(before.rect) * scale;
    const v1 = pick(after.rect) * scale;
    const span = t1 - t0;
    const ramp =
      span > 0
        ? `(${String(v0)}+(${String(v1)}-${String(v0)})*(t-${String(t0)})/(${String(span)}))`
        : String(v1);
    if (i === 0) {
      // Before the first keyframe, hold its value.
      expr = `if(lt(t,${String(t0)}),${String(v0)},if(lt(t,${String(t1)}),${ramp},${expr}))`;
    } else {
      expr = `if(lt(t,${String(t1)}),${ramp},${expr})`;
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
