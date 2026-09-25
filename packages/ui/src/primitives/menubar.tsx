"use client";

// Pattern ported from OpenCut (github.com/opencut-app/opencut, MIT, Copyright 2026
// OpenCut) — apps/web/src/components/ui/menubar.tsx in the 2026 rewrite scaffold —
// rebuilt on @radix-ui/react-menubar with @montaj/ui tokens; the reuse-the-dropdown-
// part-set composition is the ported idea.
//
// "Reuse, don't duplicate" is that idea in practice: `itemClasses` below is
// `dropdown-menu.tsx`'s row recipe copied verbatim (its lines 34-39), and the
// content surface is its `DropdownMenuContent` (lines 24-25). A menubar row and
// a dropdown row must be indistinguishable, so they are literally the same
// strings — ARCHITECTURE.md §4's rule that our dropdown, not the OpenCut file,
// is the styling authority.
import * as MenubarPrimitive from "@radix-ui/react-menubar";
import { Check, ChevronRight } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/cn";

export const MenubarMenu = MenubarPrimitive.Menu;
export const MenubarGroup = MenubarPrimitive.Group;
export const MenubarSub = MenubarPrimitive.Sub;

export const Menubar = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Root>
>(function Menubar({ className, ...props }, ref) {
  return (
    <MenubarPrimitive.Root
      ref={ref}
      data-slot="menubar"
      className={cn(
        "border-border bg-bg-1 flex h-8 items-center gap-0.5 rounded-md border p-0.5",
        className,
      )}
      {...props}
    />
  );
});

export const MenubarTrigger = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Trigger>
>(function MenubarTrigger({ className, ...props }, ref) {
  return (
    <MenubarPrimitive.Trigger
      ref={ref}
      data-slot="menubar-trigger"
      className={cn(
        "text-fg-2 rounded-sm px-2 py-1 text-xs font-medium outline-none select-none",
        "hover:bg-neutral-100/7 hover:text-fg-0 data-[state=open]:bg-neutral-100/14 data-[state=open]:text-fg-0",
        className,
      )}
      {...props}
    />
  );
});

/** `dropdown-menu.tsx`'s `DropdownMenuContent` surface, `min-w` narrowed for a menu bar. */
const contentClasses = [
  "bg-bg-2 border-border z-50 min-w-44 rounded-md border p-1",
  "shadow-[var(--shadow-panel)]",
].join(" ");

export const MenubarContent = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Content>
>(function MenubarContent({ className, align = "start", sideOffset = 6, ...props }, ref) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.Content
        ref={ref}
        data-slot="menubar-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(contentClasses, className)}
        {...props}
      />
    </MenubarPrimitive.Portal>
  );
});

/** Copied verbatim from `dropdown-menu.tsx` — the two menus share one row. */
const itemClasses = [
  "text-fg-1 flex cursor-default items-center gap-2 rounded-sm px-2.5 py-2 text-sm outline-none",
  "data-[highlighted]:bg-neutral-100/7 data-[highlighted]:text-fg-0",
  "data-[disabled]:text-fg-disabled data-[disabled]:pointer-events-none",
  "[&_svg]:size-4 [&_svg]:shrink-0",
].join(" ");

/** ARCHITECTURE §4: OpenCut's `text-destructive` / `focus:bg-destructive/10`. */
const destructiveClasses =
  "text-rejected data-[highlighted]:bg-rejected/10 data-[highlighted]:text-rejected";

export const MenubarItem = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Item> & {
    readonly variant?: "default" | "destructive";
  }
>(function MenubarItem({ className, variant = "default", ...props }, ref) {
  return (
    <MenubarPrimitive.Item
      ref={ref}
      data-slot="menubar-item"
      data-variant={variant}
      className={cn(itemClasses, variant === "destructive" && destructiveClasses, className)}
      {...props}
    />
  );
});

export const MenubarCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.CheckboxItem>
>(function MenubarCheckboxItem({ className, children, ...props }, ref) {
  return (
    <MenubarPrimitive.CheckboxItem
      ref={ref}
      data-slot="menubar-checkbox-item"
      className={cn(itemClasses, "relative pl-8", className)}
      {...props}
    >
      <span className="absolute left-2.5 flex size-4 items-center justify-center">
        <MenubarPrimitive.ItemIndicator>
          <Check className="text-fg-0 size-3.5" aria-hidden="true" />
        </MenubarPrimitive.ItemIndicator>
      </span>
      {children}
    </MenubarPrimitive.CheckboxItem>
  );
});

export const MenubarSubTrigger = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.SubTrigger>
>(function MenubarSubTrigger({ className, children, ...props }, ref) {
  return (
    <MenubarPrimitive.SubTrigger
      ref={ref}
      data-slot="menubar-sub-trigger"
      className={cn(itemClasses, "data-[state=open]:bg-neutral-100/7", className)}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-3.5" aria-hidden="true" />
    </MenubarPrimitive.SubTrigger>
  );
});

export const MenubarSubContent = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.SubContent>
>(function MenubarSubContent({ className, ...props }, ref) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.SubContent
        ref={ref}
        data-slot="menubar-sub-content"
        className={cn(contentClasses, className)}
        {...props}
      />
    </MenubarPrimitive.Portal>
  );
});

export const MenubarLabel = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Label>
>(function MenubarLabel({ className, ...props }, ref) {
  return (
    <MenubarPrimitive.Label
      ref={ref}
      data-slot="menubar-label"
      className={cn(
        "text-fg-2 px-2.5 py-1.5 text-2xs font-medium tracking-wide uppercase",
        className,
      )}
      {...props}
    />
  );
});

export const MenubarSeparator = React.forwardRef<
  React.ComponentRef<typeof MenubarPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Separator>
>(function MenubarSeparator({ className, ...props }, ref) {
  return (
    <MenubarPrimitive.Separator
      ref={ref}
      data-slot="menubar-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
});

/**
 * The shortcut a row advertises. Display only — `lib/edg/keyboard-shortcuts.ts`'s
 * `classify()` remains the single source of the actual bindings, so a label here
 * that drifts from it is a bug in the caller, not a second binding.
 */
export function MenubarShortcut({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <span
      data-slot="menubar-shortcut"
      className={cn("text-fg-2 ml-auto text-2xs tracking-widest", className)}
      {...props}
    />
  );
}
