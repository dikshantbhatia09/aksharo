import * as React from "react";

/** Every settings section is a `<section>` with one `<h1>` and a lead line. */
export function SettingsSection({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-5"
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-fg-2 text-sm">{description}</p>
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
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-fg-0 text-sm font-medium">{label}</p>
        {description === undefined ? null : <p className="text-fg-2 text-xs">{description}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
