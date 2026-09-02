"use client";

import * as React from "react";

import { cn } from "../lib/cn";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  /** Marks the field invalid for assistive technology and paints the red border. */
  invalid?: boolean;
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid === true ? true : props["aria-invalid"]}
      className={cn(
        "bg-bg-1 border-border text-fg-0 placeholder:text-fg-2 h-9 w-full rounded-sm border px-3 text-sm",
        "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
        "hover:border-fg-2/60 disabled:text-fg-disabled disabled:cursor-not-allowed",
        "aria-[invalid=true]:border-rejected",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "bg-bg-1 border-border text-fg-0 placeholder:text-fg-2 min-h-20 w-full rounded-sm border px-3 py-2 text-sm",
        "aria-[invalid=true]:border-rejected",
        className,
      )}
      {...props}
    />
  );
});
