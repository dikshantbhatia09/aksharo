import * as React from "react";

import { cn } from "../lib/cn";

/**
 * The top of every app and marketing page, and the home of the system's
 * signature: the title hangs from a short rani bar (the `shirorekha`
 * utility in `tokens.css`), the way Devanagari letters hang from their
 * headline. Use it once per page. Nothing else in a page should carry the bar.
 *
 * The title is the display face (Anek Latin); the description and actions are
 * Inter like the rest of the chrome. `actions` holds at most one `primary`
 * button — it is the page's one primary action.
 */
export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title: React.ReactNode;
  /** A short line above the title that places the page (a section name, not a slogan). */
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** `lg` for a landing surface such as Home or a marketing hero; `md` everywhere else. */
  size?: "md" | "lg";
  /** Heading level; a page's own title is the default `h1`. */
  as?: "h1" | "h2";
}

export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  size = "md",
  as: Heading = "h1",
  className,
  ...props
}: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-4", className)}
      {...props}
    >
      <div className="shirorekha min-w-0 max-w-3xl">
        {eyebrow ? (
          <p className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-fg-2">{eyebrow}</p>
        ) : null}
        <Heading
          className={cn(
            "font-display font-semibold tracking-[-0.01em] text-fg-0 [font-stretch:92%]",
            size === "lg" ? "text-3xl sm:text-[2.75rem] sm:leading-[3rem]" : "text-2xl",
          )}
        >
          {title}
        </Heading>
        {description ? <p className="mt-2 text-sm text-fg-1">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
