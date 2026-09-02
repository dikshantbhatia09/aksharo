"use client";

import * as React from "react";

import { useApiClient, defineEndpoint } from "@montaj/api-client";
import type { StyleDoc } from "@montaj/caption-styles";
import type { EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";
import type { RenderManifest } from "@montaj/render-manifest";
import { Button } from "@montaj/ui";

import { ExportDialog } from "./ExportDialog";

/** `GET /projects/{projectId}/media/{mediaId}/urls` — mirrors `mediaEndpoints.urls` in `@montaj/api-client`. */
const mediaUrlsEndpoint = defineEndpoint<void, { proxy?: string }>({
  method: "GET",
  path: "/projects/{projectId}/media/{mediaId}/urls",
  auth: "bearer",
});

export interface ExportButtonProps {
  readonly projectId: string;
  readonly primaryMediaId: string | undefined;
  readonly projection: EdgProjection;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry | undefined;
  readonly shaper: Shaper | undefined;
}

/**
 * The editor's Export entry point (brief §5). Mounted in `editor-client.tsx`'s
 * toolbar — see the file-boundary note in the final report: that file sits
 * outside `apps/web/components/editor/export/**`, but the dialog has to be
 * triggered from somewhere in A15's shell, and a one-line mount is the
 * smallest change that does it.
 */
export function ExportButton(props: ExportButtonProps): React.JSX.Element {
  const client = useApiClient();
  const [open, setOpen] = React.useState(false);

  const resolveSourceUrl = React.useCallback(
    async (manifest: RenderManifest): Promise<string> => {
      // Only the derived (proxy) bucket has a client-reachable signed URL today
      // (`GET /projects/{id}/media/{mediaId}/urls`, `MediaUrls.proxy`). The
      // manifest's `source.bucket` can also be `"raw"` — the full-quality S3
      // original — for which no signed-URL endpoint is exposed to the browser
      // in this codebase; see the final report's "raw source" gap. This
      // resolver always uses the proxy URL and documents the quality
      // trade-off rather than guessing at an endpoint shape that does not
      // exist.
      const urls = await client.call(mediaUrlsEndpoint, {
        params: { projectId: props.projectId, mediaId: manifest.source.mediaId },
      });
      if (urls.proxy === undefined) {
        throw new Error("no signed URL is available for this project's media yet");
      }
      return urls.proxy;
    },
    [client, props.projectId],
  );

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="editor-export-open"
        onClick={() => setOpen(true)}
        disabled={props.primaryMediaId === undefined}
      >
        Export
      </Button>
      <ExportDialog
        open={open}
        onOpenChange={setOpen}
        projectId={props.projectId}
        projection={props.projection}
        catalogue={props.catalogue}
        registry={props.registry}
        shaper={props.shaper}
        resolveSourceUrl={resolveSourceUrl}
      />
    </>
  );
}
