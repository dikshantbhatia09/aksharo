"use client";

/**
 * "Share" — the owner-side share-link screen, finally given a door.
 *
 * B15 built the share-link API and `components/review/ShareLinksPanel.tsx` and
 * then had nowhere to mount the panel; the projects "⋯" menu's Share item has
 * been disabled ever since, saying so in its own comment. OC-02 builds a
 * menubar, which is exactly the missing entry point, so File → Share… opens
 * this and the kebab item becomes real again.
 *
 * The dialog owns no share logic of its own — the panel is the feature and
 * already talks to `lib/share/hooks`. This is the frame around it, scaffolded
 * from `RetranscribeDialog.tsx` so the two editor dialogs behave identically,
 * and controlled-only: the menubar item is the trigger.
 */

import * as React from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@montaj/ui";

import { ShareLinksPanel } from "@/components/review/ShareLinksPanel";

export interface ShareDialogProps {
  readonly projectId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ShareDialog({
  projectId,
  open,
  onOpenChange,
}: ShareDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="share-dialog" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Share this project</DialogTitle>
          <DialogDescription>
            Create a link to send for review. Each link carries its own scope, and you can revoke
            one at any time.
          </DialogDescription>
        </DialogHeader>

        {/* The links panel is only mounted while the dialog is open, so its
            `GET /projects/{id}/share-links` does not fire on every editor
            load for a user who never opens Share. */}
        {open ? <ShareLinksPanel projectId={projectId} /> : null}
      </DialogContent>
    </Dialog>
  );
}
