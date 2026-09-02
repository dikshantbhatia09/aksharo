/**
 * Manifest → `@montaj/timemap`.
 *
 * The manifest's `timemap.edits` are `@montaj/render-manifest`'s wire form of
 * `@montaj/timemap`'s edit union (D30) — same field names, same discriminant —
 * so this is a type-narrowing pass-through, not a re-derivation.
 */

import type { RenderManifest } from "@montaj/render-manifest";
import { buildTimeMap, type TimeMap } from "@montaj/timemap";

export function timeMapFromManifest(manifest: RenderManifest): TimeMap {
  return buildTimeMap({
    sourceDurationMs: manifest.timemap.sourceDurationMs,
    edits: manifest.timemap.edits,
    ...(manifest.timemap.fps === undefined ? {} : { fps: manifest.timemap.fps }),
    snapCutsToFrames: manifest.timemap.snapCutsToFrames,
  });
}

/** The rendered (output) duration this manifest's timemap produces. */
export function outputDurationMsFor(manifest: RenderManifest): number {
  if (manifest.timemap.edits.length === 0) return manifest.timemap.sourceDurationMs;
  return timeMapFromManifest(manifest).outputDurationMs;
}
