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
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 lg:flex-row lg:gap-10">
      <nav aria-label="Settings" className="lg:w-56 lg:shrink-0">
        <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
          {SETTINGS_NAV.map((section) => {
            const active = isActivePath(pathname, section.href);
            return (
              <li key={section.key}>
                <Link
                  href={section.href}
                  aria-current={active ? "page" : undefined}
                  data-testid={`settings-nav-${section.key}`}
                  className={cn(
                    "block rounded-sm px-3 py-2 text-sm whitespace-nowrap",
                    active ? "bg-bg-2 text-lime-500" : "text-fg-1 hover:bg-bg-2 hover:text-fg-0",
                  )}
                >
                  {section.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
