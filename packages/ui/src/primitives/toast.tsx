"use client";

import { Toaster as SonnerToaster, toast } from "sonner";

import type * as React from "react";

/**
 * Toasts. `sonner` rather than a hand-rolled queue: it already gets the parts
 * that are easy to get wrong right — an ARIA live region, hover-to-hold,
 * stacking, and dismissal that does not steal focus.
 *
 * Copy rule (08 §6): a toast says what happened and what to do next, never just
 * "Error".
 */
export function Toaster(props: React.ComponentProps<typeof SonnerToaster>): React.JSX.Element {
  return (
    <SonnerToaster
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: "!bg-bg-2 !border-border !text-fg-0 !rounded-md !border !font-sans !shadow-[var(--shadow-md)]",
          description: "!text-fg-2",
          // A toast floats over a page that already spends its one primary
          // action, so its action is the outlined secondary, never a rani fill.
          actionButton:
            "!bg-transparent !text-fg-0 !border !border-border-hover !font-medium hover:!bg-neutral-100/7",
          cancelButton: "!bg-transparent !text-fg-1 hover:!bg-neutral-100/7",
          closeButton: "!bg-bg-2 !border-border !text-fg-1 hover:!text-fg-0",
          error: "!border-rejected/60",
          success: "!border-accepted/60",
        },
      }}
      {...props}
    />
  );
}

export { toast };
