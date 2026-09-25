"use client";

import * as React from "react";

import type { StyleDoc } from "@montaj/caption-styles";
import type { CanvasFaceTrack, EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";
import { Button } from "@montaj/ui";

import { ExportDialog } from "./ExportDialog";

export interface ExportButtonProps {
  readonly projectId: string;
  readonly primaryMediaId: string | undefined;
  readonly projection: EdgProjection;
  /** The media's face track on the canvas; the export keeps captions off faces. */
  readonly faces?: CanvasFaceTrack;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry | undefined;
  readonly shaper: Shaper | undefined;
  /**
   * Opens the dialog on mount. The projects "⋯" menu's Export navigates here
   * with `?export=1` rather than dropping the user in the editor and leaving
   * them to find the button again (F07-E5).
   */
  readonly defaultOpen?: boolean;
  /**
   * OC-02: File → Export… opens the same dialog from the menubar, so the open
   * state can be driven from outside. Standard controlled/uncontrolled pair —
   * omit both and the button keeps its own state (and `defaultOpen` its
   * meaning). The button itself stays either way: it is what `export.spec.ts`
   * and `gate-a.spec.ts` click, and a toolbar Export is not duplicate chrome
   * the way a second Re-transcribe button was.
   */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
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
  const [selfOpen, setSelfOpen] = React.useState(props.defaultOpen ?? false);
  const controlled = props.open !== undefined;
  const open = props.open ?? selfOpen;
  const onOpenChange = props.onOpenChange;
  const setOpen = React.useCallback(
    (next: boolean): void => {
      if (!controlled) setSelfOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  return (
    <>
      <Button
        type="button"
        // The editor's one filled primary: Export is what the whole screen is
        // for. Everything else in the chrome is secondary or ghost.
        variant="primary"
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
        {...(props.faces === undefined ? {} : { faces: props.faces })}
        catalogue={props.catalogue}
        registry={props.registry}
        shaper={props.shaper}
      />
    </>
  );
}
