"use client";

import * as React from "react";

import { useApiContext } from "@montaj/api-client";
import { PageHeader, Skeleton } from "@montaj/ui";

import { ExportUpsellPanel } from "@/components/editor/export/upsell/ExportUpsellPanel";
import { refreshSession } from "@/lib/session/client";

/**
 * The demo shell: a mock "watermarked export preview" plus the real panel, so
 * a reviewer (or a Playwright e2e) can drive the full nine-rupee purchase
 * flow against the workspace the signed-in session belongs to.
 *
 * **Session bootstrap.** Every `(app)` route gets an access token for free —
 * `components/shell/app-shell.tsx` rotates the httpOnly refresh cookie into
 * one on mount, and everything downstream (`useWorkspaceId()`, and so every
 * workspace-scoped query including `useOffersEligibility()`) waits on that.
 * `/ui-kit/*` lives under `(admin)`, which has no such layout — this demo
 * page is the one place in that route group that calls a *workspace-scoped*
 * hook, so it needs the same one-rotation-on-mount bootstrap `AppShell` does,
 * copied rather than imported so this route never depends on the shell
 * mounting. Without it `useWorkspaceId()` stays `null` forever here, the
 * panel's query stays `enabled: false` forever, and `isPending` never
 * resolves either way — which reads exactly like a hang, not a bug in the
 * panel itself.
 */
export function ExportUpsellPanelDemo(): React.JSX.Element {
  const [ready, setReady] = React.useState(false);
  const [bootstrapped, setBootstrapped] = React.useState(false);
  const [bootstrapFailed, setBootstrapFailed] = React.useState(false);
  const { session: sessionStore } = useApiContext();

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (sessionStore.getAccessToken() !== null) {
        setBootstrapped(true);
        return;
      }
      const refreshed = await refreshSession();
      if (cancelled) return;
      if (refreshed === null) {
        setBootstrapFailed(true);
        return;
      }
      sessionStore.set(refreshed.accessToken);
      setBootstrapped(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionStore]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 bg-bg-0 px-4 py-8 sm:px-6">
      <PageHeader
        eyebrow="UI kit"
        title="Export upsell panel"
        description="Mounts exactly what the export dialog renders for a watermarked export."
      />
      <div
        className="border-border flex h-40 items-center justify-center rounded-md border border-dashed"
        data-testid="export-upsell-demo-preview"
      >
        <span className="text-fg-2 text-sm">Watermarked preview</span>
      </div>
      {bootstrapFailed ? (
        <p
          role="alert"
          className="text-rejected text-sm"
          data-testid="export-upsell-demo-signed-out"
        >
          Sign in to preview the upsell panel.
        </p>
      ) : bootstrapped ? (
        <ExportUpsellPanel
          onCleanManifestReady={() => {
            setReady(true);
          }}
        />
      ) : (
        <Skeleton className="h-32" data-testid="export-upsell-demo-bootstrapping" />
      )}
      {ready ? (
        <p role="status" className="text-accepted text-sm" data-testid="export-upsell-demo-ready">
          Clean manifest ready. The dialog would request the export again now.
        </p>
      ) : null}
    </main>
  );
}
