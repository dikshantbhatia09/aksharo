"use client";

// Pattern ported from OpenCut (github.com/opencut-app/opencut, MIT,
// Copyright 2026 OpenCut) — apps/web/src/components/ui/context-menu.tsx in the
// 2026 rewrite scaffold — restyled to @montaj/ui tokens on radix primitives.

/**
 * The right-click menu. Same part-set as the ported source (items with a
 * `destructive` variant and `inset`, a shortcut slot, checkbox items,
 * submenus), but every class is copied from our own `dropdown-menu.tsx` so
 * the two menus are visually one component — that file is the styling
 * authority, not the OpenCut original. The enter/exit animation classes of
 * the source are deliberately dropped (they need `tw-animate-css`, which this
 * package does not depend on).
 */
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { Check, ChevronRight } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/cn";

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

/** The popup surface — `dropdown-menu.tsx`'s surface, narrowed to `min-w-44`. */
export const ContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(function ContextMenuContent({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        ref={ref}
        className={cn(
          "bg-bg-2 border-border z-50 min-w-44 rounded-md border p-1 duration-100",
          "shadow-[var(--shadow-panel)]",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
});

// Copied verbatim from `dropdown-menu.tsx` so a row in either menu is the
// same row. `data-[inset]` is the ported API's indent slot for a group of
// items whose siblings carry an icon or a check.
const itemClasses = [
  "text-fg-1 flex cursor-default items-center gap-2 rounded-sm px-2.5 py-2 text-sm outline-none",
  "data-[highlighted]:bg-bg-1 data-[highlighted]:text-fg-0",
  "data-[disabled]:text-fg-disabled data-[disabled]:pointer-events-none",
  "[&_svg]:size-4 [&_svg]:shrink-0",
  "data-[inset]:pl-7",
].join(" ");

/** `text-destructive` / `focus:bg-destructive/10` in the source (ARCHITECTURE §4). */
const destructiveClasses =
  "text-red-400 data-[highlighted]:bg-red-400/10 data-[highlighted]:text-red-400";

export interface ContextMenuItemProps extends React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitive.Item
> {
  readonly variant?: "default" | "destructive";
  readonly inset?: boolean;
}

export const ContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Item>,
  ContextMenuItemProps
>(function ContextMenuItem({ className, variant = "default", inset = false, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Item
      ref={ref}
      data-variant={variant}
      {...(inset ? { "data-inset": "" } : {})}
      className={cn(itemClasses, variant === "destructive" && destructiveClasses, className)}
      {...props}
    />
  );
});

export const ContextMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(function ContextMenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn(itemClasses, "relative pl-8", className)}
      {...props}
    >
      <span className="absolute left-2.5 flex size-4 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <Check className="size-4 text-lime-500" aria-hidden="true" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
});

export interface ContextMenuLabelProps extends React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitive.Label
> {
  readonly inset?: boolean;
}

export const ContextMenuLabel = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Label>,
  ContextMenuLabelProps
>(function ContextMenuLabel({ className, inset = false, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Label
      ref={ref}
      {...(inset ? { "data-inset": "" } : {})}
      className={cn(
        "text-fg-2 text-2xs px-2.5 py-1.5 font-medium tracking-wide uppercase",
        "data-[inset]:pl-7",
        className,
      )}
      {...props}
    />
  );
});

export const ContextMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(function ContextMenuSeparator({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Separator
      ref={ref}
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
});

/** The right-hand shortcut column. Presentational — the binding lives in the keyboard map. */
export function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"span">): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn("text-fg-3 ml-auto pl-4 text-xs tracking-widest", className)}
      {...props}
    />
  );
}

export const ContextMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & {
    readonly inset?: boolean;
  }
>(function ContextMenuSubTrigger({ className, inset = false, children, ...props }, ref) {
  return (
    <ContextMenuPrimitive.SubTrigger
      ref={ref}
      {...(inset ? { "data-inset": "" } : {})}
      className={cn(itemClasses, "data-[state=open]:bg-bg-1", className)}
      {...props}
    >
      {children}
      <ChevronRight className="text-fg-3 ml-auto size-4" aria-hidden="true" />
    </ContextMenuPrimitive.SubTrigger>
  );
});

export const ContextMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(function ContextMenuSubContent({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.SubContent
      ref={ref}
      className={cn(
        "bg-bg-2 border-border z-50 min-w-44 rounded-md border p-1 duration-100",
        "shadow-[var(--shadow-panel)]",
        className,
      )}
      {...props}
    />
  );
});
