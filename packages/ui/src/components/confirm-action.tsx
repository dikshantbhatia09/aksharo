"use client";

import * as React from "react";

import { Button } from "../primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../primitives/dialog";

/**
 * A destructive action behind one confirmation step.
 *
 * `trigger` is the existing button, unchanged — it keeps its label, variant and
 * `data-testid` — and now opens a short dialog instead of acting. The dialog
 * says what will happen in `description`, offers Cancel (focused first, so
 * Enter does not destroy anything) and a `danger` button named for the action
 * (`confirmLabel`, e.g. "Revoke key", never "OK"). HIG `alerts.md` ›
 * Best practices: confirm destructive actions people can't undo, and label the
 * buttons with what they do.
 *
 * Use it for actions that cannot be undone from the same screen (revoking a key
 * or a session, removing a member, deleting a webhook). Reversible actions —
 * archive, a toggle — should not ask.
 */
export interface ConfirmActionProps {
  trigger: React.ReactElement;
  title: React.ReactNode;
  description: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<unknown>;
  /** `data-testid` of the confirm button; defaults to `confirm-action`. */
  confirmTestId?: string;
}

export function ConfirmAction({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  confirmTestId = "confirm-action",
}: ConfirmActionProps) {
  const [open, setOpen] = React.useState(false);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        data-testid="confirm-action-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="ghost"
            onClick={() => {
              setOpen(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            data-testid={confirmTestId}
            onClick={() => {
              setOpen(false);
              void onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
