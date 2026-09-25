"use client";

import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import * as React from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { cn } from "../lib/cn";

/**
 * The command palette primitive (`cmdk`), styled for the studio.
 *
 * `CommandDialog` keeps the title and description mounted but visually hidden:
 * a dialog without an accessible name is a serious axe violation, and the
 * palette has no visible heading by design.
 */
export const Command = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(function Command({ className, ...props }, ref) {
  return (
    <CommandPrimitive
      ref={ref}
      className={cn("text-fg-0 flex h-full w-full flex-col overflow-hidden", className)}
      {...props}
    />
  );
});

export function CommandDialog({
  open,
  onOpenChange,
  label,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  description: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="bg-bg-1/95 top-24 max-w-2xl translate-y-0 overflow-hidden p-0 backdrop-blur-md"
        aria-label={label}
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command loop>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}

export const CommandInput = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(function CommandInput({ className, ...props }, ref) {
  return (
    <div className="border-border flex items-center gap-2 border-b px-4">
      <Search className="text-fg-2 size-4 shrink-0" aria-hidden="true" />
      <CommandPrimitive.Input
        ref={ref}
        className={cn(
          "placeholder:text-fg-2 h-12 w-full bg-transparent text-sm outline-none",
          className,
        )}
        {...props}
      />
    </div>
  );
});

export const CommandList = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(function CommandList({ className, ...props }, ref) {
  return (
    <CommandPrimitive.List
      ref={ref}
      className={cn("scrollbar-thin max-h-80 overflow-y-auto overflow-x-hidden p-2", className)}
      {...props}
    />
  );
});

export const CommandEmpty = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(function CommandEmpty({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Empty
      ref={ref}
      className={cn("text-fg-2 py-8 text-center text-sm", className)}
      {...props}
    />
  );
});

export const CommandGroup = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(function CommandGroup({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Group
      ref={ref}
      className={cn(
        "[&_[cmdk-group-heading]]:text-fg-2 [&_[cmdk-group-heading]]:px-2",
        "[&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs",
        "[&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase",
        className,
      )}
      {...props}
    />
  );
});

export const CommandItem = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(function CommandItem({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        "text-fg-1 flex cursor-default items-center gap-2.5 rounded-sm px-2 py-2 text-sm",
        "data-[selected=true]:bg-neutral-100/7 data-[selected=true]:text-fg-0",
        "data-[disabled=true]:text-fg-disabled data-[disabled=true]:pointer-events-none",
        "[&_svg]:text-fg-2 [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
});

export const CommandSeparator = CommandPrimitive.Separator;
