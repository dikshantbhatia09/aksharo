"use client";

import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";

import type { VariantProps } from "class-variance-authority";

/**
 * The one button.
 *
 * **The primary is an accent outline on transparent, never a fill.** That is
 * Nocturne's rule, not a preference: "Buttons are outlined (1px accent border
 * on transparent), not solid-filled", and "do not flood large areas with the
 * accent". The accent is spent on lines, glows and 10–20 % tints; a filled
 * button is the largest block of pure accent a screen can have, and half a
 * dozen of them is what turns a dark interface loud. `variant="primary"`
 * should still appear once per surface — the discipline is about which action
 * is *the* action, and that has not changed.
 *
 * `danger` keeps its fill. Destruction is the one action that has to be
 * unmistakable at a glance, and an outlined destructive button reads as one
 * more option rather than as the last one.
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
        // The label lightens as the ground lifts. With a filled button the
        // hover tint sits BEHIND the text and contrast rises; with an outline
        // the label IS the accent, so tinting the ground alone pushes it the
        // wrong way — measured 4.71:1 at rest on a card, 3.97 hovered, 3.37
        // pressed, i.e. straight through the 4.5:1 AA floor on the product's
        // main action. Moving the text one step up the ramp restores it
        // (8.5:1 hovered, 7.3:1 pressed) and is also what Nocturne asks for:
        // on a dark ground a state change moves toward the light end.
        primary: [
          "border border-accent bg-transparent text-accent",
          "hover:bg-accent/12 hover:text-accent-300",
          "active:bg-accent/22 active:text-accent-200",
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
          "bg-transparent text-accent px-1 hover:bg-accent/10 hover:text-accent-300 active:bg-accent/18 active:text-accent-200",
        danger: "bg-rejected text-ink hover:bg-rejected/85",
        link: "bg-transparent text-accent underline-offset-4 hover:underline",
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
