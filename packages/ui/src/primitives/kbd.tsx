// Pattern ported from OpenCut (github.com/opencut-app/opencut, MIT,
// Copyright 2026 OpenCut) — apps/web/src/components/ui/kbd.tsx in the
// 2026 rewrite scaffold — restyled to @montaj/ui tokens.

/**
 * A keycap. `cmdk`'s part-set has no shortcut slot of its own (unlike our
 * menubar's `MenubarShortcut`), so the command palette composes its shortcuts
 * out of these instead — one cap per key, `KbdGroup` holding the row.
 *
 * The size and colour are `MenubarShortcut`'s (`menubar.tsx` line 209)
 * deliberately: the same shortcut must not look like two different things
 * depending on whether the user found it in a menu or in the palette. No
 * `"use client"` — it is a plain element with no hooks or handlers.
 */
import * as React from "react";

import { cn } from "../lib/cn";

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">): React.JSX.Element {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded-sm",
        "text-fg-2 border-border bg-bg-2 border px-1 font-sans text-2xs font-medium select-none",
        className,
      )}
      {...props}
    />
  );
}

export function KbdGroup({ className, ...props }: React.ComponentProps<"span">): React.JSX.Element {
  return (
    <span
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}
