"use client";

import * as React from "react";

/**
 * The watermark notice (`08 §4 v2`). There is deliberately no toggle here —
 * the manifest carries the watermark decision (`RenderManifest.watermark`,
 * signed) and the client cannot remove it; this panel only explains why and
 * offers the upgrade paths (`UpgradeGate` slots: signup gift, ₹9 pass, plan).
 * `UpgradeGate` itself is B04's component and out of this work package's file
 * boundary — the slots below are placeholders for it.
 */
export function WatermarkNotice({
  watermarked,
  reasons,
}: {
  readonly watermarked: boolean | undefined;
  readonly reasons: readonly string[] | undefined;
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
      <p className="text-fg-3 mt-2">
        Remove it with your free signup gift, a ₹9 one-time pass, or a paid plan.
      </p>
    </div>
  );
}
