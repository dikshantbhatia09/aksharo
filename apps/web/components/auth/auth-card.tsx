import Link from "next/link";
import * as React from "react";

import { BRAND } from "@montaj/config";
import { PageHeader } from "@montaj/ui";

/**
 * The frame every auth page sits in.
 *
 * A `<main>` with exactly one `<h1>`, so each screen has a single, correct
 * document outline — axe checks that, and so does anyone using a screen reader
 * to work out where they landed.
 *
 * Shirorekha layout: the title is the page's `PageHeader` (the one place the
 * rani bar appears), hung *above* the card rather than inside it, and the card
 * holds only the form or message. The wordmark above is a plain link home in
 * the display face — it is the brand mark, not a heading.
 */
export function AuthCard({
  title,
  subtitle,
  eyebrow,
  children,
  footer,
}: {
  title: string;
  subtitle?: React.ReactNode;
  /** A short placing line above the title, e.g. "Step 2 of 2". */
  eyebrow?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-4 py-12 sm:px-6 sm:py-16">
      <Link
        href="/"
        aria-label={`${BRAND.name} home`}
        className="font-display text-fg-0 inline-flex min-h-8 items-center self-start rounded-sm text-xl font-semibold tracking-tight no-underline"
      >
        {BRAND.name}
      </Link>

      <div className="flex flex-col gap-5">
        <PageHeader
          title={title}
          {...(eyebrow === undefined ? {} : { eyebrow })}
          {...(subtitle === undefined ? {} : { description: subtitle })}
        />

        <div className="border-border bg-surface flex flex-col gap-5 rounded-md border p-5 sm:p-6">
          {children}
        </div>
      </div>

      {/* A paragraph, not a div: the footer is a sentence with a link in it, and
          a link inside a text block has to be underlined to be distinguishable
          without colour (WCAG 1.4.1). The token stylesheet keys off the tag. */}
      {footer === undefined ? null : <p className="text-fg-2 text-center text-sm">{footer}</p>}
    </main>
  );
}

/**
 * The one style for an inline text link on the auth screens: `accent-300`
 * (8.2:1 on the page, 7.4:1 on a card), underlined so it never depends on
 * colour alone. The full accent is reserved for the primary button.
 */
export const AUTH_LINK_CLASS =
  "text-accent-300 hover:text-accent-200 rounded-sm underline underline-offset-4";
