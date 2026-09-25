"use client";

import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";

import type { VariantProps } from "class-variance-authority";

/**
 * The one button.
 *
 * **The primary is a rani fill with ink text (5.5:1)**, the prominent style
 * Apple's HIG asks for on a key action such as Save or Export. It is the
 * single largest block of accent a screen may have, so `variant="primary"`
 * appears **once per surface** — everything else is `secondary` (an outline)
 * or `ghost`. This replaced Nocturne's outlined primary on 2026-09-25: an
 * outline made the main action look like one more option.
 *
 * `danger` is filled too, in the rejected hue, so destruction stays
 * unmistakable and never reads as the brand action.
 *
 * Motion is a 160 ms colour transition; `prefers-reduced-motion` collapses it in
 * `tokens.css` rather than here, so no component has to remember.
 */
export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm",
    "text-sm font-medium select-none",
    "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
    "disabled:pointer-events-none disabled:text-fg-disabled disabled:opacity-60",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        // Ink on rani is 5.51:1 at rest; the hover and press steps move the
        // fill one step lighter (accent-400, 6.6:1; accent-300 pressed, 8.2:1) rather than darker, so the
        // label only gains contrast as the state changes.
        primary: [
          "bg-accent text-on-accent font-semibold",
          "hover:bg-accent-400 active:bg-accent-300",
        ].join(" "),
        secondary: [
          "border border-border bg-transparent text-fg-0",
          "hover:bg-neutral-100/7 active:bg-neutral-100/14",
        ].join(" "),
        // `outline` predates `secondary` taking the outlined shape and is now
        // the same control with quieter text. Kept so ~40 call sites do not
        // all have to change in one diff.
        outline: [
          "border border-border bg-transparent text-neutral-300",
          "hover:bg-neutral-100/7 hover:text-fg-0",
        ].join(" "),
        ghost:
          "bg-transparent text-fg-1 px-2 hover:bg-neutral-100/7 hover:text-fg-0 active:bg-neutral-100/14",
        danger: "bg-rejected text-ink font-semibold hover:bg-rejected/85",
        link: "bg-transparent text-accent-300 underline underline-offset-4 hover:text-accent-200",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-11 px-6 text-base",
        icon: "size-9 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the child element instead of a `<button>` (a `<Link>`, typically). */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, type, ...props },
  ref,
) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      ref={ref}
      // A button inside a form defaults to `submit`; that has surprised enough
      // people that every non-`asChild` button says what it is.
      {...(asChild ? {} : { type: type ?? "button" })}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});
