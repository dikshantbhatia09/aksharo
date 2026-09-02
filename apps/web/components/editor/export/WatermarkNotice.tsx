"use client";

import * as React from "react";

import { ExportUpsellPanel } from "./upsell/ExportUpsellPanel";

/**
 * The watermark notice (`08 §4 v2`). There is deliberately no toggle here —
 * the manifest carries the watermark decision (`RenderManifest.watermark`,
 * signed) and the client cannot remove it. B04's `ExportUpsellPanel`
 * (signup gift → ₹9 clean export → week pass → "See plans") is mounted here,
 * exactly at the mount point its own header documents: it drives its own
 * eligibility and checkout, and calls back once a clean path is confirmed
 * available so the dialog can re-issue the same export request.
 */
export function WatermarkNotice({
  watermarked,
  reasons,
  onCleanManifestReady,
}: {
  readonly watermarked: boolean | undefined;
  readonly reasons: readonly string[] | undefined;
  readonly onCleanManifestReady?: () => void;
}): React.JSX.Element | null {
  if (watermarked !== true) return null;
  return (
    <div
      className="mt-3 rounded-md border border-white/10 bg-white/5 p-3 text-xs"
      data-testid="export-watermark-notice"
    >
      <p className="text-fg-2 font-medium">This export carries the Aksharo watermark.</p>
      {reasons?.map((reason, index) => (
        <p key={index} className="text-fg-3 mt-1">
          {reason}
        </p>
      ))}
      <ExportUpsellPanel className="mt-2" onCleanManifestReady={onCleanManifestReady} />
    </div>
  );
}
