"use client";

import * as React from "react";

import type { StyleDoc } from "@montaj/caption-styles";
import type { EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";
import { Button } from "@montaj/ui";

import { ExportDialog } from "./ExportDialog";

export interface ExportButtonProps {
  readonly projectId: string;
  readonly primaryMediaId: string | undefined;
  readonly projection: EdgProjection;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry | undefined;
  readonly shaper: Shaper | undefined;
  /**
   * Opens the dialog on mount. The projects "⋯" menu's Export navigates here
   * with `?export=1` rather than dropping the user in the editor and leaving
   * them to find the button again (F07-E5).
   */
  readonly defaultOpen?: boolean;
}

/**
 * The editor's Export entry point (brief §5). Mounted in `editor-client.tsx`'s
 * toolbar — see the file-boundary note in the final report: that file sits
 * outside `apps/web/components/editor/export/**`, but the dialog has to be
 * triggered from somewhere in A15's shell, and a one-line mount is the
 * smallest change that does it.
 *
 * A21b's `POST /projects/{id}/exports` now returns `sources: {rawUrl,
 * proxyUrl?, watermarkUrl?}` alongside the manifest — signed GETs for the
 * original media and the watermark PNG — so `use-export-dialog.ts` no longer
 * needs this component to resolve a source URL itself (A19's original
 * proxy-only workaround is gone).
 */
export function ExportButton(props: ExportButtonProps): React.JSX.Element {
  const [open, setOpen] = React.useState(props.defaultOpen ?? false);

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
      />
    </>
  );
}
