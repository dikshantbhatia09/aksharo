"use client";

/**
 * "Regenerate translation" confirmation (A22 brief item 4).
 *
 * Regenerating a translation submits a fresh `SetSegmentText{script:
 * "translated"}` batch for every segment, which replaces whatever text a user
 * may have hand-edited into that override — the backend applies it
 * unconditionally (a real conflict from a *simultaneous* edit still comes back
 * as a 409, but a translation regenerated a day after the user's last edit is
 * not a conflict, it is exactly what was asked for). This dialog is the
 * product's confirmation that the user meant to ask for it, not a backend
 * safety net.
 */

import * as React from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@montaj/ui";

export interface RegenerateTranslationDialogProps {
  readonly open: boolean;
  /** BCP-47 tag of the translation being regenerated, e.g. `"en"`. */
  readonly language: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}

export function RegenerateTranslationDialog({
  open,
  language,
  onOpenChange,
  onConfirm,
}: RegenerateTranslationDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Regenerate this translation?</DialogTitle>
          <DialogDescription>
            This replaces the current {languageName(language)} translation, including any edits you
            have made to it. This cannot be undone from here.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              onConfirm();
            }}
          >
            Regenerate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  hi: "Hindi",
  ta: "Tamil",
  te: "Telugu",
  bn: "Bengali",
  mr: "Marathi",
  gu: "Gujarati",
  kn: "Kannada",
  ml: "Malayalam",
  pa: "Punjabi",
};

function languageName(tag: string): string {
  return LANGUAGE_NAMES[tag.split("-")[0]?.toLowerCase() ?? tag] ?? tag;
}
