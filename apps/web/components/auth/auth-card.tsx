import Link from "next/link";
import * as React from "react";

import { BRAND } from "@montaj/config";

/**
 * The frame every auth page sits in.
 *
 * A `<main>` with exactly one `<h1>`, so each screen has a single, correct
 * document outline — axe checks that, and so does anyone using a screen reader
 * to work out where they landed.
 */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
      <Link
        href="/"
        className="font-display text-fg-0 rounded-sm text-xl font-semibold tracking-tight"
      >
        {BRAND.name}
      </Link>

      <div className="bg-bg-1 border-border flex flex-col gap-5 rounded-md border p-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-fg-0 text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle === undefined ? null : <div className="text-fg-2 text-sm">{subtitle}</div>}
        </div>
        {children}
      </div>

      {/* A paragraph, not a div: the footer is a sentence with a link in it, and
          a link inside a text block has to be underlined to be distinguishable
          without colour (WCAG 1.4.1). The token stylesheet keys off the tag. */}
      {footer === undefined ? null : <p className="text-fg-2 text-center text-sm">{footer}</p>}
    </main>
  );
}
