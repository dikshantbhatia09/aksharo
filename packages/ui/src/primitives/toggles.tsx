"use client";

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Check } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/cn";

/**
 * Consent lives on these two controls, so they are deliberately plain: a switch
 * that is off looks off, and nothing is pre-checked anywhere in the product
 * (D60 — every consent toggle starts false).
 */
export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        "border-border data-[state=unchecked]:bg-bg-2 data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
        // The visible track is 20 px; the hit area is extended to 32 px so the
        // control meets the pointer floor without changing any layout.
        "after:absolute after:-inset-x-1 after:-inset-y-1.5 after:content-['']",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "bg-fg-0 pointer-events-none block size-4 rounded-full transition-transform",
          "data-[state=unchecked]:translate-x-0.5 data-[state=checked]:translate-x-4",
          "data-[state=checked]:bg-on-accent",
        )}
      />
    </SwitchPrimitive.Root>
  );
});

export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        "border-border-hover bg-sunken relative size-4 shrink-0 rounded-[4px] border",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        // 16 px box, 32 px hit area (see Switch).
        "after:absolute after:-inset-2 after:content-['']",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="text-on-accent flex items-center justify-center">
        <Check className="size-3.5" aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});

export const Separator = React.forwardRef<
  React.ComponentRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(function Separator({ className, orientation = "horizontal", ...props }, ref) {
  return (
    <SeparatorPrimitive.Root
      ref={ref}
      orientation={orientation}
      className={cn(
        "bg-border shrink-0",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
});
