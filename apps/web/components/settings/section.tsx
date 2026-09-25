import * as React from "react";

import { PageHeader } from "@montaj/ui";

/**
 * Every settings section is a `<section>` whose top is the page's one
 * `PageHeader` — the section name is the page title (an `h1` carrying the
 * shirorekha), with "Settings" as the eyebrow that places it. A settings
 * route renders exactly one of these; sub-groups inside it use `SettingsGroup`.
 */
export function SettingsSection({
  title,
  description,
  actions,
  children,
  testId,
}: {
  title: string;
  description: string;
  /** At most one `primary` button — it is the page's one primary action. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-8"
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      <PageHeader eyebrow="Settings" title={title} description={description} actions={actions} />
      {children}
    </section>
  );
}

/**
 * A titled group inside a settings page (an `h2`, never a second title). Used
 * where one route holds two related tools, e.g. API keys and webhooks.
 */
export function SettingsGroup({
  title,
  description,
  actions,
  children,
  testId,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-3"
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-fg-0 text-base font-semibold">{title}</h2>
          {description === undefined ? null : <p className="text-fg-2 text-sm">{description}</p>}
        </div>
        {actions === undefined ? null : (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
      {children}
    </section>
  );
}

/** A row inside a settings card: label, help text, control on the right. */
export function SettingsRow({
  label,
  description,
  control,
}: {
  label: string;
  description?: string;
  control: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-fg-0 text-sm font-medium">{label}</p>
        {description === undefined ? null : <p className="text-fg-2 text-xs">{description}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/**
 * Inline link inside settings/billing prose: `accent-300`, underlined, the
 * same treatment as `Button variant="link"` (DESIGN.md › Components).
 */
export const INLINE_LINK_CLASS =
  "text-accent-300 rounded-sm underline underline-offset-4 hover:text-accent-200";
