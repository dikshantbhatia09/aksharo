"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { Input } from "@montaj/ui";

import type { DocsNavSection, DocsSearchDoc } from "@/lib/docs/schema";

import { loadDocsSearchIndex } from "@/lib/docs/search";

/** `path.split("/")` for `/docs/developers/v1/projects` -> readable crumbs:
 * Docs / Developers / V1 / Projects. Labels come from the nav where a segment
 * matches a known href, so "Developers" reads correctly instead of the raw
 * "developers" segment; unmatched segments (a dynamic `[slug]`, `v1`) fall
 * back to a humanised version of the segment itself. */
function useBreadcrumb(nav: readonly DocsNavSection[]): { label: string; href: string }[] {
  const pathname = usePathname();
  return React.useMemo(() => {
    const segments = pathname.split("/").filter(Boolean); // ["docs", ...]
    const crumbs: { label: string; href: string }[] = [{ label: "Docs", href: "/docs" }];
    let href = "";
    for (const segment of segments) {
      href += `/${segment}`;
      if (href === "/docs") continue;
      const known = nav
        .flatMap((section) => [{ href: section.href, label: section.label }, ...section.items])
        .find((entry) => entry.href === href);
      const label =
        known?.label ?? segment.charAt(0).toUpperCase() + segment.slice(1).replaceAll("-", " ");
      crumbs.push({ label, href });
    }
    return crumbs;
  }, [pathname, nav]);
}

function DocsBreadcrumb({ nav }: { readonly nav: readonly DocsNavSection[] }): React.JSX.Element {
  const crumbs = useBreadcrumb(nav);
  return (
    <nav aria-label="Breadcrumb" data-testid="docs-breadcrumb" className="text-fg-2 text-xs">
      <ol className="flex flex-wrap items-center gap-1">
        {crumbs.map((crumb, index) => (
          <li key={crumb.href} className="flex items-center gap-1">
            {index > 0 ? <span aria-hidden>/</span> : null}
            {index === crumbs.length - 1 ? (
              <span className="text-fg-1" aria-current="page">
                {crumb.label}
              </span>
            ) : (
              <Link
                href={crumb.href}
                className="hover:text-fg-0 inline-flex min-h-8 items-center no-underline hover:underline"
              >
                {crumb.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function DocsSidebar({ nav }: { readonly nav: readonly DocsNavSection[] }): React.JSX.Element {
  const pathname = usePathname();
  return (
    <nav aria-label="Docs navigation" data-testid="docs-sidebar" className="flex flex-col gap-5">
      {nav.map((section) => (
        <div key={section.id}>
          <Link
            href={section.href}
            aria-current={pathname === section.href ? "page" : undefined}
            className="text-fg-0 inline-flex min-h-8 items-center text-sm font-semibold no-underline hover:underline"
            data-testid={`docs-nav-section-${section.id}`}
          >
            {section.label}
          </Link>
          {section.items.length > 0 ? (
            <ul className="border-border mt-1 flex flex-col border-l">
              {section.items.map((item) => (
                <li key={item.href}>
                  {/* Active row: primary text plus a short accent bar on the
                      rail, the nav-row treatment DESIGN.md › Accent budget
                      allows — not accent-coloured text. */}
                  <Link
                    href={item.href}
                    aria-current={pathname === item.href ? "page" : undefined}
                    className={
                      pathname === item.href
                        ? "text-fg-0 border-accent -ml-px flex min-h-8 items-center border-l-2 pl-3 text-sm font-medium no-underline"
                        : "text-fg-2 hover:text-fg-0 -ml-px flex min-h-8 items-center border-l-2 border-transparent pl-3 text-sm no-underline"
                    }
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </nav>
  );
}

function DocsSearch({ searchIndex }: { readonly searchIndex: string }): React.JSX.Element {
  const [query, setQuery] = React.useState("");
  const index = React.useMemo(() => loadDocsSearchIndex(searchIndex), [searchIndex]);
  const results: DocsSearchDoc[] = React.useMemo(() => {
    if (query.trim() === "") return [];
    return index.search(query).map((result) => ({
      id: String(result.id),
      title: String(result.title),
      summary: String(result.summary),
      body: "",
      section: result.section as DocsSearchDoc["section"],
      href: String(result.href),
    }));
  }, [query, index]);

  return (
    <div className="relative" data-testid="docs-search">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        type="search"
        placeholder="Search the docs"
        aria-label="Search the docs"
        className="bg-sunken"
        data-testid="docs-search-input"
      />
      {query.trim() !== "" ? (
        <ul
          className="bg-bg-1 border-border absolute z-10 mt-1 flex w-full flex-col gap-0.5 rounded-md border p-1 shadow-md"
          data-testid="docs-search-results"
          aria-label="Search results"
        >
          {results.length === 0 ? (
            <li className="text-fg-2 px-2 py-2 text-sm">
              No docs match &quot;{query}&quot;. Try a shorter word, or browse the sections below.
            </li>
          ) : (
            results.map((result) => (
              <li key={result.id}>
                <Link
                  href={result.href}
                  className="block rounded-sm px-2 py-2 no-underline hover:bg-neutral-100/7"
                >
                  <span className="text-fg-0 block text-sm font-medium">{result.title}</span>
                  <span className="text-fg-2 block text-xs">{result.summary}</span>
                </Link>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

export function DocsShell({
  nav,
  searchIndex,
  children,
}: {
  readonly nav: readonly DocsNavSection[];
  readonly searchIndex: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-12">
      <aside className="flex flex-col gap-6 lg:sticky lg:top-24 lg:h-fit">
        <DocsSearch searchIndex={searchIndex} />
        <DocsSidebar nav={nav} />
      </aside>
      <div className="flex min-w-0 flex-col gap-6" data-testid="docs-content">
        <DocsBreadcrumb nav={nav} />
        {children}
      </div>
    </div>
  );
}
