"use client";

/**
 * A18a's/A15's own pattern (`app/(app)/studio/styles`): a bare harness page,
 * not linked from any nav, that exposes the export engine on `window` for
 * Playwright to drive directly with real WebCodecs/Mediabunny in a real
 * browser — `e2e/export.spec.ts` (chromium) and `e2e/export-fallback.spec.ts`
 * (webkit) do exactly that. It loads the same editor store and renderer
 * `editor-client.tsx` does for `?projectId=`, so the projection handed to
 * `runExport` is the project's real EDG document, not a hand-built stand-in.
 */

import { useSearchParams } from "next/navigation";
import * as React from "react";

import { useApiClient } from "@montaj/api-client";
import type { ApiClient } from "@montaj/api-client";
import type { StyleDoc } from "@montaj/caption-styles";
import type { CanvasKitBackend } from "@montaj/render-canvaskit";
import type { EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";

import { useRenderer } from "@/components/editor/canvas/use-canvaskit";
import { SYSTEM_STYLE_MAP } from "@/components/editor/panels/system-styles";
import { toRenderProjection } from "@/lib/edg/render-projection";
import { useEditorStore } from "@/lib/edg/use-editor-store";
import * as ExportLib from "@/lib/export";
import { runExport } from "@/lib/export/engine";

declare global {
  interface Window {
    __exportHarness?: {
      readonly lib: typeof ExportLib;
      readonly runExport: typeof runExport;
      readonly client: ApiClient;
      readonly catalogue: ReadonlyMap<string, StyleDoc>;
      readonly projection: EdgProjection;
      readonly registry: FontRegistry;
      readonly shaper: Shaper;
      readonly backend?: CanvasKitBackend;
      readonly loadRenderer?: () => Promise<{ backend: CanvasKitBackend }>;
      ready: boolean;
    };
  }
}

function Harness({ projectId }: { readonly projectId: string }): React.JSX.Element {
  const client = useApiClient();
  const load = useEditorStore(projectId);
  const renderer = useRenderer();

  React.useEffect(() => {
    if (load.status !== "ready" || load.store === undefined) return;
    if (renderer.engine === undefined || renderer.backend === undefined) return;
    const snapshot = load.snapshot ?? load.store.getSnapshot();
    window.__exportHarness = {
      lib: ExportLib,
      runExport,
      client,
      catalogue: SYSTEM_STYLE_MAP,
      projection: toRenderProjection(snapshot.state),
      registry: renderer.engine.registry,
      shaper: renderer.engine.shaper,
      backend: renderer.backend,
      loadRenderer: async () => ({ backend: renderer.backend! }),
      ready: true,
    };
  }, [client, load.status, load.store, load.snapshot, renderer.engine, renderer.backend]);

  return (
    <div
      data-testid="export-harness-ready"
      data-ready={String(window.__exportHarness?.ready === true)}
    >
      export harness
    </div>
  );
}

function HarnessRoot(): React.JSX.Element {
  const params = useSearchParams();
  const projectId = params.get("projectId") ?? "";
  if (projectId === "")
    return <div data-testid="export-harness-missing-project">missing projectId</div>;
  return <Harness projectId={projectId} />;
}

export default function ExportHarnessPage(): React.JSX.Element {
  return (
    <React.Suspense fallback={<div data-testid="export-harness-loading">loading</div>}>
      <HarnessRoot />
    </React.Suspense>
  );
}

// Re-exported so the test can also construct a standalone client when needed
// (e.g. before the harness component has mounted).
