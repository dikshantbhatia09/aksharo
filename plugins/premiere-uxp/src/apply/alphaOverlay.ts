/**
 * Alpha overlay (C06 brief §Scope 3): for caption styles A18a flags as outside MOGRT coverage
 * (`packages/caption-styles`'s `requiresLayoutMetrics`/parity flags, checked by the caller
 * before invoking this), request a cloud alpha render (A20, ProRes 4444 or a PNG sequence)
 * through the API, download it via the bridge, import to the bin and place it on the caption
 * track. This module does not itself decide *which* styles need an alpha overlay — the caller
 * (the apply-mode orchestrator, `src/apply/runApply.ts`) passes only the segments already
 * routed here.
 */
import type { MediaBinImportResult, PremiereHost } from "../host/premiere.js";

/** A downloaded alpha-render file, already on local disk (the bridge's download step — HTTP
 * transport and the render-request API call are out of this WP's scope; see brief "consumes
 * A20"). */
export interface AlphaOverlayAsset {
  readonly segmentId: string;
  readonly localPath: string;
  readonly startFrames: number;
  readonly endFrames: number;
}

export interface PlacedAlphaOverlay {
  readonly segmentId: string;
  readonly binItemId: string;
  readonly trackItemId: string;
}

export async function placeAlphaOverlays(
  host: PremiereHost,
  trackIndex: number,
  assets: readonly AlphaOverlayAsset[],
): Promise<PlacedAlphaOverlay[]> {
  const placed: PlacedAlphaOverlay[] = [];
  for (const asset of assets) {
    const imported: MediaBinImportResult = await host.importMediaToBin({
      sourcePath: asset.localPath,
      binName: "Aksharo alpha overlays",
    });
    const { trackItemId } = await host.placeOnTrack({
      itemId: imported.itemId,
      trackIndex,
      startFrames: asset.startFrames,
      durationFrames: asset.endFrames - asset.startFrames,
    });
    placed.push({ segmentId: asset.segmentId, binItemId: imported.itemId, trackItemId });
  }
  return placed;
}
