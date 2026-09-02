"use client";

/**
 * The "style" chip of the Home quick-pick row (08 §Home: "Hinglish (Roman) ·
 * Punch Pop · 9:16"). Collapsed, it shows the picked style's own static
 * preview PNG — cheap to paint on a page that has not loaded CanvasKit yet.
 * Clicking it opens a `Sheet` around A16's real `StylePicker`, wired to
 * `GET /styles` (system styles plus this workspace's own presets); its live
 * animated hover previews are exactly what that panel already does inside the
 * editor.
 */
import * as React from "react";

import { useStyles } from "@montaj/api-client";
import type { StyleDoc } from "@montaj/caption-styles";
import { Button, Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, Skeleton } from "@montaj/ui";

import { StylePicker } from "@/components/editor/panels/StylePicker";
import { stylePreviewUrl } from "@/lib/style-previews";


export function StyleQuickPick({
  styleId,
  onChange,
}: {
  styleId: string | undefined;
  onChange: (styleId: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const styles = useStyles();
  const entries = styles.data ?? [];
  const selected = entries.find((entry) => entry.id === styleId);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
        className="h-auto gap-2 py-1.5 pl-1.5 pr-3"
        data-testid="quick-pick-style"
      >
        {styles.isPending ? (
          <Skeleton className="size-7 rounded-sm" />
        ) : selected?.previewKey === null || selected?.previewKey === undefined ? (
          <span className="bg-bg-2 flex size-7 items-center justify-center rounded-sm text-2xs">
            Aa
          </span>
        ) : (
          <img
            src={stylePreviewUrl(selected.previewKey)}
            alt=""
            className="size-7 rounded-sm object-cover"
            data-testid="quick-pick-style-preview"
          />
        )}
        <span>{selected?.name ?? "Choose a style"}</span>
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" data-testid="style-quick-pick-sheet">
          <SheetHeader>
            <SheetTitle>Caption style</SheetTitle>
          </SheetHeader>
          <SheetBody className="flex min-h-0 flex-1">
            <StylePicker
              styles={(entries as unknown as StyleDoc[]) ?? []}
              selectedStyleId={styleId}
              scope={{ kind: "doc" }}
              onOp={(op) => {
                if (op.styleRef !== undefined) {
                  onChange(op.styleRef);
                  setOpen(false);
                }
              }}
              className="min-h-0 flex-1"
            />
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}
