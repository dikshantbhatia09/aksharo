"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@montaj/ui";

import type { ReactNode } from "react";

import { isActivePath, SETTINGS_NAV } from "@/lib/nav";

/**
 * Settings is a two-column layout with its own navigation landmark, so a screen
 * reader user can tell the section list apart from the sidebar (08 §6).
 */
export default function SettingsLayout({ children }: { children: ReactNode }): React.JSX.Element {
  const pathname = usePathname();

  return (
    <div className="grid w-full grid-cols-1 gap-5 md:grid-cols-[minmax(0,196px)_minmax(0,1fr)]">
      <nav aria-label="Settings">
        <ul className="flex gap-0.5 overflow-x-auto md:flex-col md:overflow-visible">
          {SETTINGS_NAV.map((section) => {
            const active = isActivePath(pathname, section.href);
            return (
              <li key={section.key}>
                <Link
                  href={section.href}
                  aria-current={active ? "page" : undefined}
                  data-testid={`settings-nav-${section.key}`}
                  className={cn(
                    // `no-underline`: the base stylesheet underlines any <a>
                    // inside an <li> for WCAG 1.4.1, which is right for a link
                    // in a sentence and wrong for a section list.
                    "flex min-h-9 items-center rounded-sm px-3 py-2 text-sm whitespace-nowrap no-underline",
                    "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
                    active
                      ? "bg-accent/14 text-accent-200 font-medium"
                      : "text-fg-1 hover:bg-neutral-100/7 hover:text-fg-0",
                  )}
                >
                  {section.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex min-w-0 max-w-[720px] flex-col gap-4">{children}</div>
    </div>
  );
}
