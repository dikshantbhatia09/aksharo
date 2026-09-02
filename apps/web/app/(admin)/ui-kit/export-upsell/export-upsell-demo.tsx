"use client";

import * as React from "react";

import { ExportUpsellPanel } from "@/components/editor/export/upsell/ExportUpsellPanel";

/**
 * The demo shell: a mock "watermarked export preview" plus the real panel, so
 * a reviewer (or a Playwright e2e) can drive the full ₹9 purchase flow
 * against the workspace the signed-in session belongs to.
 */
export function ExportUpsellPanelDemo(): React.JSX.Element {
  const [ready, setReady] = React.useState(false);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-fg-0 text-lg font-semibold">Export upsell panel</h1>
      <p className="text-fg-2 text-sm">
        Mounts exactly what the export dialog will render for a watermarked export.
      </p>
      <div
        className="border-border flex h-40 items-center justify-center rounded-md border border-dashed"
        data-testid="export-upsell-demo-preview"
      >
        <span className="text-fg-2 text-sm">watermark preview</span>
      </div>
      <ExportUpsellPanel
        onCleanManifestReady={() => {
          setReady(true);
        }}
      />
      {ready ? (
        <p className="text-lime-500 text-sm" data-testid="export-upsell-demo-ready">
          Clean manifest ready — the dialog would re-request the export now.
        </p>
      ) : null}
    </div>
  );
}
