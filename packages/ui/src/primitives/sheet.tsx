"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva } from "class-variance-authority";
import { X } from "lucide-react";
import * as React from "react";

import { DialogOverlay, DialogPortal } from "./dialog";
import { cn } from "../lib/cn";

import type { VariantProps } from "class-variance-authority";

/**
 * A dialog anchored to an edge: the mobile navigation drawer, the checkout sheet
 * `UpgradeGate` opens (B03 fills it in), the project detail panel (A14).
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const sheetVariants = cva(
  "bg-bg-1 border-border fixed z-50 flex flex-col shadow-[var(--shadow-panel)] focus:outline-none",
  {
    variants: {
      side: {
        left: "inset-y-0 left-0 h-full w-80 max-w-[85vw] border-r",
        right: "inset-y-0 right-0 h-full w-96 max-w-[90vw] border-l",
        bottom: "inset-x-0 bottom-0 max-h-[85vh] rounded-t-lg border-t",
      },
    },
    defaultVariants: { side: "right" },
  },
);

export const SheetContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> &
    VariantProps<typeof sheetVariants>
>(function SheetContent({ className, children, side, ...props }, ref) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="text-fg-2 hover:text-fg-0 absolute top-4 right-4 rounded-sm"
          aria-label="Close"
        >
          <X className="size-4" aria-hidden="true" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

export function SheetHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div className={cn("border-border flex flex-col gap-1 border-b p-5", className)} {...props} />
  );
}

export function SheetBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("scrollbar-thin flex-1 overflow-y-auto p-5", className)} {...props} />;
}
