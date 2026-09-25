"use client";

import { AlertCircle, CheckCircle2 } from "lucide-react";
import * as React from "react";

import { cn } from "@montaj/ui";

/**
 * The admin console's own small kit, on Shirorekha tokens.
 *
 * Every admin panel is the same three things: a page title (`PageHeader`
 * from `@montaj/ui`), one or more cards or tables, and a status line for
 * what the last request did. These keep those identical across fifteen
 * routes so an operator scanning between them reads the same layout every
 * time (HIG layout › Visual hierarchy: "Align elements to make them easier
 * to scan").
 */

/** The page column: one gutter and one section gap for every admin route. */
export function AdminPage({
  children,
  className,
  width = "wide",
}: {
  children: React.ReactNode;
  className?: string;
  /** `form` caps the column at a readable form width; `wide` is for tables. */
  width?: "wide" | "form";
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col gap-8",
        width === "form" ? "max-w-xl" : "max-w-6xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A titled group. Cards are the one container: hairline, surface, 20 px. */
export function AdminSection({
  title,
  description,
  actions,
  children,
  className,
  bare = false,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Drop the card chrome when the child is already a bordered table. */
  bare?: boolean;
}): React.JSX.Element {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id={headingId} className="text-base font-semibold text-fg-0">
            {title}
          </h2>
          {description === undefined ? null : (
            <p className="mt-0.5 text-sm text-fg-2">{description}</p>
          )}
        </div>
        {actions === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {bare ? children : <div className={adminCard}>{children}</div>}
    </section>
  );
}

export const adminCard = "rounded-md border border-border bg-surface p-5";

/**
 * What a request did wrong, next to the thing that failed. Icon + words, never
 * colour alone (HIG accessibility › Vision: "Convey information with more
 * than color alone").
 */
export function AdminError({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-sm border border-rejected/40 bg-rejected/10 px-3 py-2 text-sm text-fg-0",
        className,
      )}
      {...props}
    >
      <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-rejected" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

/** Confirmation that a significant action completed (HIG feedback › Best practices). */
export function AdminSuccess({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-sm border border-accepted/40 bg-accepted/10 px-3 py-2 text-sm text-fg-0",
        className,
      )}
      {...props}
    >
      <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accepted" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

export function AdminLoading({ label = "Loading…" }: { label?: string }): React.JSX.Element {
  return (
    <p role="status" className="text-sm text-fg-2">
      {label}
    </p>
  );
}

/** A one-line empty state: what belongs here and, when there is one, what to do. */
export function AdminEmpty({
  title,
  description,
}: {
  title: string;
  description?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <p className="text-sm font-medium text-fg-1">{title}</p>
      {description === undefined ? null : <p className="text-sm text-fg-2">{description}</p>}
    </div>
  );
}

/**
 * A data table in a card. It scrolls sideways inside its own box so a wide
 * table never scrolls the page at 360 px (DESIGN.md › Accessibility floor).
 */
export function AdminTable({
  label,
  children,
  className,
}: {
  /** Names the table for assistive technology when no visible caption does. */
  label: string;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("overflow-x-auto rounded-md border border-border bg-surface", className)}>
      <table aria-label={label} className="w-full text-left text-sm text-fg-1">
        {children}
      </table>
    </div>
  );
}

export const th =
  "border-b border-border px-4 py-2.5 text-xs font-medium whitespace-nowrap text-fg-2";
export const td = "px-4 py-2.5 align-middle";
export const tr = "border-t border-border first:border-t-0 hover:bg-neutral-100/5";

/** A link inside a table or detail list: reads as text, clearly a link on hover and focus. */
export const rowLink =
  "text-fg-0 underline decoration-fg-2/60 underline-offset-4 hover:decoration-fg-0";

/** The native select, dressed like `Input` so forms read as one set. */
export const AdminSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function AdminSelect({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        "h-9 rounded-sm border border-border bg-bg-1 px-3 text-sm text-fg-0",
        "transition-colors duration-[160ms] hover:border-fg-2/60",
        className,
      )}
      {...props}
    />
  );
});

/** A headline number. Large figures are the one place besides titles that use the display face. */
export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className={adminCard}>
      <p className="text-xs font-medium text-fg-2">{label}</p>
      <p className="mt-1 font-display text-3xl font-semibold tabular-nums text-fg-0 [font-stretch:92%]">
        {value}
      </p>
      {hint === undefined ? null : <p className="mt-1 text-xs text-fg-2">{hint}</p>}
    </div>
  );
}
