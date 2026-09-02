"use client";

import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";

import type { VariantProps } from "class-variance-authority";

/**
 * The one button. Lime is reserved for the primary action on a surface (08 §1),
 * so `variant="primary"` should appear once per view.
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
        primary: "bg-lime-500 text-on-accent hover:bg-lime-600",
        secondary: "bg-bg-2 text-fg-0 border border-border hover:bg-bg-2/70",
        outline: "border border-border bg-transparent text-fg-1 hover:bg-bg-2 hover:text-fg-0",
        ghost: "bg-transparent text-fg-1 hover:bg-bg-2 hover:text-fg-0",
        danger: "bg-rejected text-on-accent hover:bg-rejected/85",
        link: "bg-transparent text-lime-500 underline-offset-4 hover:underline",
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
