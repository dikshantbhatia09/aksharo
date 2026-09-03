/**
 * Applies captions to the active comp (brief items 1-2): styled text layers for a style the
 * classification table (`src/styles/ae-style-map.ts`) marks "supported", or the alpha overlay
 * fallback (A20) otherwise — one call, one `AeHost#undoGroup`, so a whole apply (or a whole
 * re-apply) is one entry in After Effects' Edit > Undo stack, per brief item 1: "one undo group
 * per apply." Re-sync (brief item 2: "re-sync replaces tagged layers only") removes every
 * previously Aksharo-tagged layer for the same `projectId` before adding the new ones, so a
 * second apply for the same project never leaves stale duplicate layers behind.
 */
import type { StyleDoc } from "@montaj/caption-styles";

import { buildTextLayerSpecs, type CaptionSegmentInput } from "../layers/textLayerSpec.js";
import { classifyStyle } from "../styles/ae-style-map.js";

import type { AeHost, AksharoLayerMetadata } from "../host/ae.js";

export interface ApplyCaptionsRequest {
  readonly projectId: string;
  readonly rev: number;
  readonly compId: string;
  readonly compWidthPx: number;
  readonly compHeightPx: number;
  readonly style: StyleDoc;
  readonly segments: readonly CaptionSegmentInput[];
  /** Pre-rendered alpha overlay clip (A20), used when the style isn't text-layer-exact. */
  readonly overlaySourcePath: string;
}

export interface ApplyCaptionsResult {
  readonly mode: "styled-text-layers" | "alpha-overlay";
  readonly layerIds: readonly string[];
  readonly styleSupport: ReturnType<typeof classifyStyle>["support"];
}

/** Removes every layer this project previously tagged, so a re-apply never duplicates. */
async function removeExistingProjectLayers(host: AeHost, projectId: string): Promise<void> {
  const tracked = await host.listAksharoLayers();
  for (const layer of tracked) {
    if (layer.metadata.aksharo.projectId === projectId) {
      await host.removeLayer(layer.layerId);
    }
  }
}

export async function applyCaptions(
  host: AeHost,
  request: ApplyCaptionsRequest,
): Promise<ApplyCaptionsResult> {
  const { support } = classifyStyle(request.style);

  return host.undoGroup("Aksharo: apply captions", async () => {
    await removeExistingProjectLayers(host, request.projectId);

    if (support === "unsupported" || support === "approximate") {
      const { layerId } = await host.importOverlay({
        sourcePath: request.overlaySourcePath,
        compId: request.compId,
      });
      const metadata: AksharoLayerMetadata = {
        aksharo: { projectId: request.projectId, rev: request.rev },
      };
      await host.tagLayer(layerId, metadata);
      return { mode: "alpha-overlay", layerIds: [layerId], styleSupport: support };
    }

    const specs = buildTextLayerSpecs({
      compWidthPx: request.compWidthPx,
      compHeightPx: request.compHeightPx,
      style: request.style,
      segments: request.segments,
    });
    const { layerIds } = await host.addTextLayers(request.compId, specs);
    for (let i = 0; i < layerIds.length; i += 1) {
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      const layerId = layerIds[i];
      if (!layerId) continue;
      const metadata: AksharoLayerMetadata = {
        aksharo: {
          projectId: request.projectId,
          // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
          segmentId: request.segments[i]?.segmentId,
          rev: request.rev,
        },
      };
      await host.tagLayer(layerId, metadata);
    }
    return { mode: "styled-text-layers", layerIds, styleSupport: support };
  });
}
