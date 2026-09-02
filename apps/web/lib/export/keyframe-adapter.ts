/**
 * Manifest `timemap.keyframes` → the output-clock crop-window curve the
 * frame loop samples every frame (B20).
 *
 * A thin wrapper over `@montaj/render-core`'s `outputCropKeyframesFromTracks`
 * — the actual decode+remap logic lives there so the cloud renderer
 * (`apps/render`) shares it rather than re-implementing it; see that
 * module's doc comment for the row layout and the splice-pinning behaviour.
 */
import { outputCropKeyframesFromTracks, type CropKeyframe } from "@montaj/render-core";
import type { RenderManifest } from "@montaj/render-manifest";
import type { TimeMap } from "@montaj/timemap";

/** Decodes and output-remaps every keyframe track a manifest carries. */
export function outputCropKeyframesFromManifest(
  manifest: RenderManifest,
  timeMap: TimeMap | null,
): CropKeyframe[] {
  return outputCropKeyframesFromTracks(manifest.timemap.keyframes ?? [], timeMap);
}

export type { CropKeyframe };
