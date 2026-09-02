"use client";

/**
 * The dialog's state machine: probe once on open, request a manifest per
 * preset choice, run the engine (worker) or hand the user to the cloud path,
 * and call `POST /exports/manifests/{id}/complete` when the engine finishes.
 *
 * Deliberately not a `react-query` mutation: the export has its own
 * long-lived progress stream (`onProgress`) and a cancellation button, which
 * fit a small hand-rolled reducer better than a request/response cache entry.
 */

import * as React from "react";

import { useApiClient } from "@montaj/api-client";
import type { StyleDoc } from "@montaj/caption-styles";
import type { EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";
import type { RenderManifest } from "@montaj/render-manifest";

import {
  completeExportManifest,
  decideAudioStrategy,
  isBrowserExportEligible,
  outputDurationMsFor,
  probeExportCapabilities,
  requestExportManifest,
  sanityCheckManifest,
  toCapabilitiesRequest,
  type CreateExportRequest,
  type CreateExportResponse,
  type EngineProgress,
  type EngineResult,
  type ExportCapabilityProbe,
} from "@/lib/export";
import { runExport } from "@/lib/export/engine";

export interface ExportDialogDeps {
  readonly projectId: string;
  readonly projection: EdgProjection;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry | undefined;
  readonly shaper: Shaper | undefined;
}

export type ExportPhase =
  | "idle"
  | "probing"
  | "requesting"
  | "cloud-offered"
  | "rendering"
  | "completing"
  | "done"
  | "error"
  | "cancelled";

export interface ExportDialogState {
  readonly phase: ExportPhase;
  readonly probe: ExportCapabilityProbe | null;
  readonly response: CreateExportResponse | null;
  readonly manifest: RenderManifest | null;
  readonly progress: EngineProgress | null;
  readonly result: EngineResult | null;
  readonly error: string | null;
}

const INITIAL_STATE: ExportDialogState = {
  phase: "idle",
  probe: null,
  response: null,
  manifest: null,
  progress: null,
  result: null,
  error: null,
};

/** Fetches the watermark PNG bytes from A21b's presigned `sources.watermarkUrl`. */
async function fetchWatermarkBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`could not fetch the watermark asset: ${String(response.status)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function useExportDialog(deps: ExportDialogDeps): {
  readonly state: ExportDialogState;
  readonly startExport: (request: CreateExportRequest) => Promise<void>;
  readonly cancel: () => void;
  readonly reset: () => void;
} {
  const client = useApiClient();
  const [state, setState] = React.useState<ExportDialogState>(INITIAL_STATE);
  const controllerRef = React.useRef<AbortController | null>(null);

  const reset = React.useCallback(() => setState(INITIAL_STATE), []);

  const cancel = React.useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const startExport = React.useCallback(
    async (request: CreateExportRequest): Promise<void> => {
      setState((s) => ({ ...s, phase: "probing", error: null }));
      const probe = await probeExportCapabilities({
        width: request.customWidth,
        height: request.customHeight,
      });
      setState((s) => ({ ...s, probe, phase: "requesting" }));

      const eligible = isBrowserExportEligible(probe);
      const capabilities = toCapabilitiesRequest(probe);

      const { response, manifest } = await requestExportManifest(client, deps.projectId, {
        ...request,
        mode: request.mode ?? (eligible ? "auto" : "cloud"),
        capabilities,
      });
      setState((s) => ({ ...s, response, manifest }));

      if (manifest === null) {
        // Cloud path (or subtitle-only, or an ineligible browser — A21b's
        // decision.ts now itself refuses "auto" for a browser lacking H.264
        // decode+encode or a usable audio path, and for an HDR source):
        // nothing more for the engine to do. The dialog shows
        // `response.reasons` and, for a cloud video export, `response.job`.
        setState((s) => ({ ...s, phase: "cloud-offered" }));
        return;
      }

      const outputDurationMs = outputDurationMsFor(manifest);
      const sanity = sanityCheckManifest(manifest, outputDurationMs);
      if (!sanity.ok) {
        setState((s) => ({
          ...s,
          phase: "error",
          error: sanity.expired
            ? "This export link expired before rendering started — try again."
            : sanity.notYetValid
              ? "This export link is not valid yet (clock skew) — try again."
              : `This render exceeds the workspace's plan: ${sanity.capViolations
                  .map((v) => v.cap)
                  .join(", ")}.`,
        }));
        return;
      }

      if (deps.registry === undefined || deps.shaper === undefined) {
        setState((s) => ({
          ...s,
          phase: "error",
          error: "The renderer has not finished loading yet.",
        }));
        return;
      }

      if (response.sources === undefined) {
        setState((s) => ({
          ...s,
          phase: "error",
          error: "The API did not return source URLs for this browser export (A21b `sources`).",
        }));
        return;
      }
      const sources = response.sources;

      const audioDecision = decideAudioStrategy({
        manifest,
        aacEncodable: probe.audio.aac,
        aacPolyfillAvailable: true,
      });
      if (audioDecision.kind === "cloud-required") {
        setState((s) => ({ ...s, phase: "cloud-offered", error: audioDecision.reason }));
        return;
      }

      const controller = new AbortController();
      setState((s) => ({ ...s, phase: "rendering" }));
      controllerRef.current = controller;

      try {
        // A21b's `rawUrl` is the ORIGINAL media (S3) — a 540p proxy cannot
        // produce a clean ≥1080p export, so the engine always decodes it,
        // falling back to `proxyUrl` only if `rawUrl` is somehow absent.
        const sourceUrl = sources.rawUrl ?? sources.proxyUrl;
        if (sourceUrl === undefined) {
          throw new Error("no source URL was returned for this export");
        }
        const watermarkUrl = sources.watermarkUrl;
        const result = await runExport({
          manifest,
          source: sourceUrl,
          projection: deps.projection,
          catalogue: deps.catalogue,
          registry: deps.registry,
          shaper: deps.shaper,
          signal: controller.signal,
          aacEncodable: probe.audio.aac,
          aacPolyfillAvailable: true,
          fetchWatermarkAsset:
            watermarkUrl === undefined ? undefined : () => fetchWatermarkBytes(watermarkUrl),
          onProgress: (progress) => setState((s) => ({ ...s, progress })),
        });
        setState((s) => ({ ...s, phase: "completing", result }));
        await completeExportManifest(client, manifest.manifestId, {
          sizeBytes: result.sizeBytes,
          durationMs: result.durationMs,
          checksum: result.checksum,
        });
        setState((s) => ({ ...s, phase: "done" }));
      } catch (error) {
        if (error instanceof Error && error.name === "ExportCancelledError") {
          setState((s) => ({ ...s, phase: "cancelled" }));
          return;
        }
        setState((s) => ({
          ...s,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [client, deps],
  );

  return { state, startExport, cancel, reset };
}
